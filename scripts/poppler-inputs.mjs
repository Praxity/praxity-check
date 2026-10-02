export const poppler = { version: "26.03.0", url: "https://poppler.freedesktop.org/poppler-26.03.0.tar.xz", sha256: "8b3c5e2a9f2ab4c3ec5029f28af1b433c6b71f0d1e7b3997aa561cf1c0ca4ebe" };
export const popplerData = { version: "0.4.12", url: "https://poppler.freedesktop.org/poppler-data-0.4.12.tar.gz", sha256: "c835b640a40ce357e1b83666aabd95edffa24ddddd49b8daff63adb851cdab74" };
export const popplerTools = ["pdfinfo", "pdffonts", "pdfimages", "pdftotext", "pdftoppm", "pdftohtml"];
export const windowsPoppler = {
	baseline: "9e593bb18ea69cc5095e012465dcd675a822ed0d", triplet: "check-x64-windows-static",
	dependencies: [{ name: "freetype", "default-features": false }, "fontconfig", "libjpeg-turbo", "libpng", "tiff", "openjpeg", "lcms", "zlib"],
	// Transitive runtime packages at this registry revision; host tools are not shipped.
	packages: ["dirent", "expat", "fontconfig", "freetype", "lcms", "libjpeg-turbo", "liblzma", "libpng", "openjpeg", "tiff", "zlib"],
};
export function patchPopplerData(original) {
	const marker = "    // scan the encoding in reverse";
	if (!original.includes(marker) || !original.includes("#include <cstring>")) throw new Error("Poppler data patch context changed");
	return original.replace("#include <cstring>", "#include <cstring>\n#include <cstdlib>").replace(marker,
		'    if (popplerDataDir.empty()) {\n        if (const char *dataDir = std::getenv("POPPLER_DATADIR")) {\n            popplerDataDir = dataDir;\n        }\n    }\n' + marker);
}
