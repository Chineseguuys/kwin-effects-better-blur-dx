uniform sampler2D texUnit;
uniform vec2 noiseTextureSize;

varying vec2 uv;

void main(void)
{
    vec2 uvNoise = vec2(gl_FragCoord.xy / noiseTextureSize);
    vec3 noise = texture2D(texUnit, uvNoise).rrr - vec3(128.0 / 255.0);

    gl_FragColor = vec4(noise, 0);
}
