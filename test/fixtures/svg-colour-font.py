"""Rebuild svg-colour-font.ttf with fonttools. Original CC0 test artwork.

The A glyph is a rectangle. Its COLR layer paints white, regardless of SVG fill.
No installed font or third-party outline is used.
"""
from pathlib import Path
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.colorLib.builder import buildCOLR, buildCPAL

builder = FontBuilder(1000, isTTF=True)
builder.setupGlyphOrder([".notdef", "A", "white"])
builder.setupCharacterMap({65: "A"})
glyphs = {}
for name in [".notdef", "A", "white"]:
    pen = TTGlyphPen(None)
    if name != ".notdef":
        pen.moveTo((100, 0))
        pen.lineTo((600, 0))
        pen.lineTo((600, 700))
        pen.lineTo((100, 700))
        pen.closePath()
    glyphs[name] = pen.glyph()
builder.setupGlyf(glyphs)
builder.setupHorizontalMetrics({name: (700, 0) for name in glyphs})
builder.setupHorizontalHeader(ascent=800, descent=-200)
builder.setupNameTable({"familyName": "Check Palette Probe", "styleName": "Regular",
                       "uniqueFontIdentifier": "CheckPaletteProbe-Regular",
                       "fullName": "Check Palette Probe Regular",
                       "psName": "CheckPaletteProbe-Regular"})
builder.setupOS2(sTypoAscender=800, sTypoDescender=-200, usWinAscent=800, usWinDescent=200)
builder.setupPost()
builder.setupMaxp()
builder.font["COLR"] = buildCOLR({"A": [("white", 0)]})
builder.font["CPAL"] = buildCPAL([[(1, 1, 1, 1)]])
builder.font.save(Path(__file__).with_suffix(".ttf"))
