# PDFium and wasm component notices

The @embedpdf/pdfium 2.15.1 wrapper and wasm are distributed unmodified.
wrapper-LICENSE and package-LICENSE.pdfium come from the npm package.
PDFium-LICENSE is the upstream BSD licence. The package also supplies Apache 2.0
text in its combined licence file.

Component texts are copied from upstream sources, recorded with URLs and hashes
in sources.json. They include FreeType under FTL, libjpeg-turbo and IJG, OpenJPEG,
Little CMS, zlib, libpng, Anti-Grain Geometry, bigint, ICU, Abseil and Emscripten.
This software includes work of the FreeType Project, www.freetype.org.
The Foxit-fonts-NOTICE retains the upstream font-data copyright and licence
reference. Those standard font substitutes remain inside the wasm.

The package does not supply a native build manifest or PDFium build number.
The source URLs identify the retained licence texts, not a verified build
revision or a claim that every optional upstream component is enabled.
The wasm hash binds this notice set to the distributed package asset.
