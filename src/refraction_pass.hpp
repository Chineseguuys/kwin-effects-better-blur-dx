#pragma once

#include <core/rendertarget.h>

#include <opengl/glshader.h>

#include <QMatrix4x4>
#include <QVector2D>
#include <QVector4D>
#include <QtNumeric>

#include <memory>

namespace BBDX {

class RefractionPass {
private:
    std::unique_ptr<KWin::GLShader> m_shader;
    // contrast parameters
    int m_mvpMatrixLocation;
    int m_colorMatrixLocation;
    int m_offsetLocation;
    int m_halfpixelLocation;
    // refraction parameters
    int m_refractionRectSizeLocation;
    int m_refractionEdgeSizePixelsLocation;
    int m_refractionCornerRadiusPixelsLocation;
    int m_refractionStrengthLocation;
    int m_refractionNormalPowLocation;
    int m_refractionRGBFringingLocation;
    int m_refractionTextureRepeatModeLocation;
    int m_refractionModeLocation;

    bool m_enabled{false};

    // user settings
    qreal m_normalPow{};
    qreal m_strength{};
    qreal m_edgeSizePixels{};
    qreal m_cornerRadiusPixels{};
    qreal m_RGBFringing{};
    int m_textureRepeatMode{};
    int m_mode{};

    RefractionPass() = default;

public:
    /**
     * Loads required shaders and sets up shader uniformLocations
     */
    static std::unique_ptr<RefractionPass> create();

    /**
     * reconfigure from BlurConfig
     */
    void reconfigure();

    /**
     * Check if refraction pass is enabled
     */
    bool enabled() const { return m_enabled; }

    /**
     * Push respective shader to the ShaderManager
     *
     * returns false if refraction is disabled
     */
    bool pushShader() const;

    /**
     * Set colorspace conversion uniforms for the current RenderTarget.
     * The shaders linearize before sampling and encode back before writing,
     * so source and destination colorspace are the same here.
     */
    void setColorspaceUniforms(const KWin::RenderTarget &renderTarget) const;

    /**
     * Set GLSL parameters
     *
     * returns false if refraction is disabled
     */
    bool setParameters(const QMatrix4x4 &projectionMatrix,
                       const QMatrix4x4 &colorMatrix,
                       const QVector2D &halfpixel,
                       const float offset,
                       const QRect &scaledBackgroundRect) const;
};

} // namespace BBDX

