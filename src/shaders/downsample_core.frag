#version 140

#include "colormanagement.glsl"

uniform sampler2D texUnit;
uniform float offset;
uniform vec2 halfpixel;

in vec2 uv;

out vec4 fragColor;

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
    vec4 sum = toLinear(texture(texUnit, uv)) * 4.0;
    sum += toLinear(texture(texUnit, uv - halfpixel.xy * offset));
    sum += toLinear(texture(texUnit, uv + halfpixel.xy * offset));
    sum += toLinear(texture(texUnit, uv + vec2(halfpixel.x, -halfpixel.y) * offset));
    sum += toLinear(texture(texUnit, uv - vec2(halfpixel.x, -halfpixel.y) * offset));

    fragColor = toEncoding(sum / 8.0);
}
