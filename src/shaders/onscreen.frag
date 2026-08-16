#include "colormanagement.glsl"

uniform sampler2D texUnit;
uniform mat4 colorMatrix;
uniform float offset;
uniform vec2 halfpixel;

varying vec2 uv;

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

void main(void)
{
    vec4 sum = toLinear(texture2D(texUnit, uv + vec2(-halfpixel.x * 2.0, 0.0) * offset));
    sum += toLinear(texture2D(texUnit, uv + vec2(-halfpixel.x, halfpixel.y) * offset)) * 2.0;
    sum += toLinear(texture2D(texUnit, uv + vec2(0.0, halfpixel.y * 2.0) * offset));
    sum += toLinear(texture2D(texUnit, uv + vec2(halfpixel.x, halfpixel.y) * offset)) * 2.0;
    sum += toLinear(texture2D(texUnit, uv + vec2(halfpixel.x * 2.0, 0.0) * offset));
    sum += toLinear(texture2D(texUnit, uv + vec2(halfpixel.x, -halfpixel.y) * offset)) * 2.0;
    sum += toLinear(texture2D(texUnit, uv + vec2(0.0, -halfpixel.y * 2.0) * offset));
    sum += toLinear(texture2D(texUnit, uv + vec2(-halfpixel.x, -halfpixel.y) * offset)) * 2.0;

    gl_FragColor = toEncoding(sum / 12.0) * colorMatrix;
}
