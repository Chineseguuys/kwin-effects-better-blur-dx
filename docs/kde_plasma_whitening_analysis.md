# 半透明窗口模糊在高亮背景下泛白问题分析

## 1. 问题原因

### 1.1 现象

对半透明窗口启用 Better Blur DX 后，当窗口后面的背景是纯白或较亮的颜色时：

- 模糊结果会泛白/发灰；
- SDR 与 HDR 下都能观察到；
- HDR 下比 SDR 更明显。

### 1.2 根因

该问题由多个因素叠加导致，核心是 blur 渲染管线没有正确使用 KWin 的颜色空间信息。

#### 1. blur 在“编码后的非线性空间”中做卷积

KWin 的 `RenderTarget` 带有 `colorDescription()`：

- SDR 渲染目标通常是 gamma 2.2 编码；
- HDR 渲染目标通常是扩展亮度范围的 gamma 2.2，或经过 PQ 管线。

而原来的 `downsample.frag`、`upsample.frag`、`onscreen.frag`、`refraction.frag` 都直接对采样到的码值做加权平均，例如：

```glsl
vec4 sum = texture2D(texUnit, uv) * 4.0;
sum += texture2D(texUnit, uv - halfpixel.xy * offset);
...
fragColor = sum / 8.0;
```

这些码值不是线性光。直接平均会让亮部和暗部产生与真实物理模糊不一致的亮度/色相偏移；在 HDR 的宽亮度范围和不同 EOTF 下，误差会被进一步放大。

#### 2. 颜色矩阵也作用在编码空间

`colorTransformMatrix()` 计算的 brightness/contrast/saturation 矩阵，最终通过：

```glsl
fragColor = (sum / 12.0) * colorMatrix;
```

直接作用在编码后的值上。高亮彩色区域再叠加饱和度调整时，通道更容易出现异常抬升或 clipping，视觉上表现为泛白。

#### 3. 噪声 pass 只有正分量

原来的噪声生成方式为：

```cpp
noiseImageLine[x] = std::rand() % m_noiseStrength;
```

shader 输出为：

```glsl
fragColor = vec4(texture2D(texUnit, uvNoise).rrr, 0);
```

然后以 `glBlendFunc(GL_ONE, GL_ONE)` 叠加。也就是说噪声只会增加亮度。

- SDR 下接近 1.0 的值会被 clip，所以纯白区域看起来变化不大；
- HDR 下 SDR 白只编码在大约 0.35 附近，仍有大量 headroom，正噪声会直接把亮部抬高，形成“白纱/泛白”。

#### 4. 缓存没有记录所属颜色空间

`BlurRenderData` 只按 view 保存纹理和 cache，没有记录这些内容是在哪个 `ColorDescription` 下生成的。当 SDR/HDR 或显示色彩配置变化时，旧颜色空间编码的缓存可能被直接绘制到新 render target 上。

---

## 2. 解决方案

### 2.1 blur 卷积改为在线性光空间完成

在 down/up-sample 和最终 onscreen/refraction shader 中：

1. 每个采样点先用 `encodingToNits()` 解码到线性 nit；
2. 在线性空间做 Dual Kawase 加权平均；
3. 写回前用 `nitsToEncoding()` 编码回当前 render target 的颜色空间。

这样 SDR 和 HDR 都使用 `RenderTarget::colorDescription()` 描述的真实 EOTF/OETF，不再把编码码值当线性值使用。

### 2.2 为每个 pass 设置 colorspace uniforms

在 C++ 侧对 downsample、upsample、onscreen 和 refraction pass 调用：

```cpp
shader->setColorspaceUniforms(
    renderTarget.colorDescription(),
    renderTarget.colorDescription(),
    RenderingIntent::RelativeColorimetricWithBPC);
```

该调用会填充 KWin `colormanagement.glsl` 所需的 source/destination transfer function 参数。

### 2.3 噪声改为零均值

- 噪声纹理改为以 128 为中心生成；
- shader 减去 `128.0 / 255.0`；
- 幅度取 `strength / 2`，保持接近原来的 dithering 强度，但不再整体抬亮画面。

### 2.4 颜色空间变化时重建缓存

`BlurRenderData` 记录当前的 `ColorDescription`。当同一 view 的颜色描述发生变化时，清空旧 offscreen 纹理并使 cache 失效，重新生成。

---

## 3. 关键代码

### 3.1 线性化 blur 采样

`src/shaders/downsample_core.frag`、`src/shaders/upsample_core.frag`、`src/shaders/onscreen_core.frag`、`src/shaders/refraction_core.frag` 中：

```glsl
#include "colormanagement.glsl"

vec4 toLinear(vec4 color)
{
    return encodingToNits(vec4(color.rgb, 1.0),
                          sourceNamedTransferFunction,
                          sourceTransferFunctionParams.x,
                          sourceTransferFunctionParams.y);
}

vec4 toEncoding(vec4 color)
{
    return nitsToEncoding(vec4(color.rgb, 1.0),
                          destinationNamedTransferFunction,
                          destinationTransferFunctionParams.x,
                          destinationTransferFunctionParams.y);
}
```

downsample 卷积改为：

```glsl
vec4 sum = toLinear(texture(texUnit, uv)) * 4.0;
sum += toLinear(texture(texUnit, uv - halfpixel.xy * offset));
...
fragColor = toEncoding(sum / 8.0);
```

最终 onscreen pass 编码后仍保持原来的颜色矩阵语义：

```glsl
fragColor = toEncoding(sum / 12.0) * colorMatrix;
```

### 3.2 设置 colorspace uniforms

`src/blur.cpp` 的 `BlurEffect::blur()`：

```cpp
m_downsamplePass.shader->setColorspaceUniforms(
    renderTarget.colorDescription(),
    renderTarget.colorDescription(),
    RenderingIntent::RelativeColorimetricWithBPC);

m_upsamplePass.shader->setColorspaceUniforms(
    renderTarget.colorDescription(),
    renderTarget.colorDescription(),
    RenderingIntent::RelativeColorimetricWithBPC);
```

onscreen/refraction 路径：

```cpp
if (!m_refractionPass->pushShader()) {
    ShaderManager::instance()->pushShader(m_onscreenPass.shader.get());
    m_onscreenPass.shader->setColorspaceUniforms(
        renderTarget.colorDescription(),
        renderTarget.colorDescription(),
        RenderingIntent::RelativeColorimetricWithBPC);
} else {
    m_refractionPass->setColorspaceUniforms(renderTarget);
}
```

`src/refraction_pass.cpp` 中：

```cpp
void BBDX::RefractionPass::setColorspaceUniforms(const KWin::RenderTarget &renderTarget) const
{
    if (!enabled()) {
        return;
    }

    m_shader->setColorspaceUniforms(renderTarget.colorDescription(),
                                    renderTarget.colorDescription(),
                                    KWin::RenderingIntent::RelativeColorimetricWithBPC);
}
```

### 3.3 零均值噪声

`src/blur.cpp` 的 `BlurEffect::ensureNoiseTexture()`：

```cpp
const int noiseAmplitude = std::max(1, m_noiseStrength / 2);
for (int y = 0; y < noiseImage.height(); y++) {
    uint8_t *noiseImageLine = (uint8_t *)noiseImage.scanLine(y);

    for (int x = 0; x < noiseImage.width(); x++) {
        const int value = (std::rand() % (2 * noiseAmplitude + 1)) - noiseAmplitude;
        noiseImageLine[x] = static_cast<uint8_t>(128 + value);
    }
}
```

`src/shaders/noise_core.frag`：

```glsl
vec3 noise = texture(texUnit, uvNoise).rrr - vec3(128.0 / 255.0);
fragColor = vec4(noise, 0);
```

### 3.4 颜色空间变化时重建缓存

`src/blur.h` 的 `BlurRenderData`：

```cpp
/// The render target color space the cached textures were created for.
/// Must be recreated when the view switches between SDR/HDR color descriptions.
std::shared_ptr<KWin::ColorDescription> colorDescription;
```

`src/blur.cpp`：

```cpp
if (!renderInfo.colorDescription
    || *renderInfo.colorDescription != *renderTarget.colorDescription()) {
    renderInfo.textures.clear();
    renderInfo.framebuffers.clear();
    if (renderInfo.cache) {
        renderInfo.cache->invalidate(
            static_cast<uint>(BlurCacheInvalidationFlag::FULL),
            "Render target color description changed");
    }
    renderInfo.colorDescription = renderTarget.colorDescription();
}
```

---

## 4. 附：关于 colormanagement.glsl

### 4.1 它来自哪里

`colormanagement.glsl` **不是本项目中的文件**，也不在本项目的 `src/blur.qrc` 中，而是 KWin 自带的 shader 头文件：

- KWin 源码位置：`src/opengl/colormanagement.glsl`
- 编译进 KWin 后的 Qt 资源路径：`:/opengl/colormanagement.glsl`

KWin 的 `GLShader` 预处理 shader 时，会把所有：

```glsl
#include "xxx.glsl"
```

统一映射到：

```text
:/opengl/xxx.glsl
```

因此修复代码中的：

```glsl
#include "colormanagement.glsl"
```

实际加载的是 KWin 内置资源 `:/opengl/colormanagement.glsl`。插件不需要、也不应该复制这份颜色管理 shader 代码；只要目标 KWin 版本支持该资源即可。本项目支持的 Plasma 6.5/6.6/6.7 均带有该文件。

### 4.2 它解决什么问题

KWin 的 render target 中保存的是**显示编码后的值**，而不是线性光。要在线性空间做 blur，就必须知道当前 render target 使用哪条 EOTF/OETF，以及黑位、峰值亮度、色域等参数。

`colormanagement.glsl` 提供 KWin 统一的颜色空间转换实现；C++ 侧的 `GLShader::setColorspaceUniforms()` 会按 `ColorDescription` 填充这些 uniform。这样 shader 无需关心具体输出是 SDR 还是 HDR、gamma 2.2 还是 PQ。

### 4.3 主要 uniform

```glsl
uniform mat4 colorimetryTransform;

uniform int sourceNamedTransferFunction;
uniform vec2 sourceTransferFunctionParams;

uniform int destinationNamedTransferFunction;
uniform vec2 destinationTransferFunctionParams;

uniform float sourceReferenceLuminance;
uniform float maxTonemappingLuminance;
uniform float destinationReferenceLuminance;
uniform float maxDestinationLuminance;

uniform mat4 destinationToLMS;
uniform mat4 lmsToDestination;
```

其中：

- `sourceTransferFunctionParams.x`：源传输函数的 luminance offset/min luminance；
- `sourceTransferFunctionParams.y`：源传输函数的 luminance scale/max-min；
- `destinationTransferFunctionParams` 同理，用于写回目标编码；
- 其余矩阵和亮度参数用于 gamut 映射和 HDR tonemapping。

### 4.4 支持的 EOTF

```glsl
const int sRGB_EOTF = 0;
const int linear_EOTF = 1;
const int PQ_EOTF = 2;
const int gamma22_EOTF = 3;
const int BT1886_EOTF = 4;
```

### 4.5 主要函数

#### 基础 EOTF/OETF

```glsl
vec3 srgbToLinear(vec3 color);
vec3 linearToSrgb(vec3 color);
vec3 linearToPq(vec3 color);
vec3 pqToLinear(vec3 color);
float singleLinearToPq(float linear);
float singlePqToLinear(float pq);
```

#### 编码值到 nits

```glsl
vec4 encodingToNits(vec4 color,
                    int sourceTransferFunction,
                    float luminanceOffset,
                    float luminanceScale);
```

作用：把源颜色描述下的显示编码值解码为线性 nits。

对 sRGB、PQ、gamma 2.2、BT.1886 等非线性格式，该函数会先做 alpha un-premultiply，完成 EOTF 后再 re-premultiply。对 `linear_EOTF` 则直接按 `luminanceScale`/`luminanceOffset` 缩放。

#### nits 到编码值

```glsl
vec4 nitsToEncoding(vec4 color,
                    int destinationTransferFunction,
                    float luminanceOffset,
                    float luminanceScale);
```

作用：把线性 nits 编码回目标颜色描述的显示编码值。

#### 组合转换与 tonemapping

```glsl
vec4 sourceEncodingToNitsInDestinationColorspace(vec4 color);
vec4 nitsToDestinationEncoding(vec4 color);
```

前者完成：

```text
源编码 → nits → colorimetry 矩阵 → tonemapping
```

后者完成：

```text
nits → 目标传输函数编码
```

`doTonemapping()` 在 HDR 需要时使用 ICtCp + modified Reinhard 进行亮度映射。

### 4.6 在本次修复中的用法

本次修复只使用了最基础、最可控的两个函数：

```glsl
vec4 toLinear(vec4 color)
{
    return encodingToNits(vec4(color.rgb, 1.0),
                          sourceNamedTransferFunction,
                          sourceTransferFunctionParams.x,
                          sourceTransferFunctionParams.y);
}

vec4 toEncoding(vec4 color)
{
    return nitsToEncoding(vec4(color.rgb, 1.0),
                          destinationNamedTransferFunction,
                          destinationTransferFunctionParams.x,
                          destinationTransferFunctionParams.y);
}
```

C++ 侧使用同一个 `renderTarget.colorDescription()` 作为 source 和 destination：

```cpp
shader->setColorspaceUniforms(
    renderTarget.colorDescription(),
    renderTarget.colorDescription(),
    RenderingIntent::RelativeColorimetricWithBPC);
```

因此流程为：

```text
render target 编码值
    → encodingToNits() 解码到线性 nits
    → Dual Kawase 加权平均
    → nitsToEncoding() 编码回 render target 颜色空间
    → 写入 blur cache / 屏幕
```

其中 `vec4(color.rgb, 1.0)` 强制 alpha 为 1，原因是 blur 采样的是窗口背后的不透明背景；这样可以避免 `encodingToNits()` 按 premultiplied alpha 处理时，因 render target alpha 为 0 或未初始化而把 RGB 错误地归零。
