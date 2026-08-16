#version 140

uniform sampler2D texUnit;
uniform vec2 noiseTextureSize;

in vec2 uv;

out vec4 fragColor;

void main(void)
{
    vec2 uvNoise = vec2(gl_FragCoord.xy / noiseTextureSize);
    vec3 noise = texture(texUnit, uvNoise).rrr - vec3(128.0 / 255.0);

    fragColor = vec4(noise, 0);
}
