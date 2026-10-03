# Offline component archives

Download each archive listed for your platform into one folder. Run
`praxity-check setup --from /path/to/folder`; add `--yes` for unattended consent.
The installer accepts the original archive filenames. It applies the same hashes
as online setup. Browser archives include Playwright's FFmpeg and Windows Winldd.
No other upstream files are needed. Java is omitted when an installed Java 17+
is usable. veraPDF uses the same universal headless installer on every target.

Browser: Chromium headless shell 151.0.7922.34, revision 1234, Playwright 1.62.1.
BSD and bundled notices; FFmpeg LGPL-2.1+. Java: Temurin JRE 17.0.20.1+1,
GPL-2.0 with Classpath Exception. veraPDF 1.30.2: GPL-3.0+ or MPL-2.0+.
Java hashes match Adoptium's adjacent `.sha256.txt` assets. Browser hashes were
measured from Playwright's selected upstream archives.

| Component | Target | Archive URL | SHA-256 | Download bytes |
| --- | --- | --- | --- | ---: |
| browser 151.0.7922.34 | win32 x64 | [chrome-headless-shell-win64.zip](https://cdn.playwright.dev/builds/cft/151.0.7922.34/win64/chrome-headless-shell-win64.zip) | `46cc69ef55ba29268ffe32dda4192a9d2165be42c3f4e923241153d519493aea` | 120106945 |
| browser 151.0.7922.34 | win32 x64 | [ffmpeg-win64.zip](https://cdn.playwright.dev/builds/ffmpeg/1011/ffmpeg-win64.zip) | `8d08827c019ad36e7b9d49d3648447d884534cb2acf200e71c715f6dd834cc50` | 1411741 |
| browser 151.0.7922.34 | win32 x64 | [winldd-win64.zip](https://cdn.playwright.dev/builds/winldd/1007/winldd-win64.zip) | `0069f0d11d4ad6df068a068c003d22fe7dbec192a47bba64b2e115e9c8ce41d8` | 128684 |
| java 17.0.20.1+1 | win32 x64 | [OpenJDK17U-jre_x64_windows_hotspot_17.0.20.1_1.zip](https://github.com/adoptium/temurin17-binaries/releases/download/jdk-17.0.20.1%2B1/OpenJDK17U-jre_x64_windows_hotspot_17.0.20.1_1.zip) | `bc21a93923103cdaac93ee337b0ae4365e739fde36df823dd456bc67c8a9d352` | 43780109 |
| verapdf 1.30.2 | win32 x64 | [verapdf-greenfield-1.30.2-installer.zip](https://software.verapdf.org/rel/1.30/verapdf-greenfield-1.30.2-installer.zip) | `6cc6341cb1af644044054b81f00a6590a7918abb18f762243de115258bcad838` | 32923960 |
| browser 151.0.7922.34 | darwin arm64 | [chrome-headless-shell-mac-arm64.zip](https://cdn.playwright.dev/builds/cft/151.0.7922.34/mac-arm64/chrome-headless-shell-mac-arm64.zip) | `cb46a336dbe3d6f1339c5039c3083e4e5dd8e4379710790e34f8f4a865e2452d` | 99275008 |
| browser 151.0.7922.34 | darwin arm64 | [ffmpeg-mac-arm64.zip](https://cdn.playwright.dev/builds/ffmpeg/1011/ffmpeg-mac-arm64.zip) | `7d77eb0d44b59acc4065faa2476c0df1a242cc904c346f820626818c953c5277` | 1097141 |
| java 17.0.20.1+1 | darwin arm64 | [OpenJDK17U-jre_aarch64_mac_hotspot_17.0.20.1_1.tar.gz](https://github.com/adoptium/temurin17-binaries/releases/download/jdk-17.0.20.1%2B1/OpenJDK17U-jre_aarch64_mac_hotspot_17.0.20.1_1.tar.gz) | `190480874ccceb358cbc840393207f77ac3e63a4c5f8129d0e23e9518b96ad05` | 42722113 |
| verapdf 1.30.2 | darwin arm64 | [verapdf-greenfield-1.30.2-installer.zip](https://software.verapdf.org/rel/1.30/verapdf-greenfield-1.30.2-installer.zip) | `6cc6341cb1af644044054b81f00a6590a7918abb18f762243de115258bcad838` | 32923960 |
| browser 151.0.7922.34 | darwin x64 | [chrome-headless-shell-mac-x64.zip](https://cdn.playwright.dev/builds/cft/151.0.7922.34/mac-x64/chrome-headless-shell-mac-x64.zip) | `608e2b5b1815b45e8bf59c9a381412b62df3ce36f2c182bc04e22fcf04ad53ea` | 103580477 |
| browser 151.0.7922.34 | darwin x64 | [ffmpeg-mac.zip](https://cdn.playwright.dev/builds/ffmpeg/1011/ffmpeg-mac.zip) | `17ed15a2fa60d3c74181befcb2bdf7c9bb288d19b2a3b9893b94b63f2ce260e4` | 1353430 |
| java 17.0.20.1+1 | darwin x64 | [OpenJDK17U-jre_x64_mac_hotspot_17.0.20.1_1.tar.gz](https://github.com/adoptium/temurin17-binaries/releases/download/jdk-17.0.20.1%2B1/OpenJDK17U-jre_x64_mac_hotspot_17.0.20.1_1.tar.gz) | `333cb81123c36568586646c73c8fa2326dab8badc43f5ea388a90fff59c9df27` | 37635516 |
| verapdf 1.30.2 | darwin x64 | [verapdf-greenfield-1.30.2-installer.zip](https://software.verapdf.org/rel/1.30/verapdf-greenfield-1.30.2-installer.zip) | `6cc6341cb1af644044054b81f00a6590a7918abb18f762243de115258bcad838` | 32923960 |
| browser 151.0.7922.34 | linux x64 | [chrome-headless-shell-linux64.zip](https://cdn.playwright.dev/builds/cft/151.0.7922.34/linux64/chrome-headless-shell-linux64.zip) | `3cfc2bd00d1bafcf8a68dc74c9c92bb7150ddc8d26ade948a776316e1cec4f14` | 120231126 |
| browser 151.0.7922.34 | linux x64 | [ffmpeg-linux.zip](https://cdn.playwright.dev/builds/ffmpeg/1011/ffmpeg-linux.zip) | `ebc74fc5b94830176a3c2914ae96bd8bc7f6a91f4f33890230f84a172ee61ccc` | 2376500 |
| java 17.0.20.1+1 | linux x64 | [OpenJDK17U-jre_x64_linux_hotspot_17.0.20.1_1.tar.gz](https://github.com/adoptium/temurin17-binaries/releases/download/jdk-17.0.20.1%2B1/OpenJDK17U-jre_x64_linux_hotspot_17.0.20.1_1.tar.gz) | `0b2b640e3046b64c8ec504de0ab9d91bb5610182bda21fad454681ce54d45a62` | 46640574 |
| verapdf 1.30.2 | linux x64 | [verapdf-greenfield-1.30.2-installer.zip](https://software.verapdf.org/rel/1.30/verapdf-greenfield-1.30.2-installer.zip) | `6cc6341cb1af644044054b81f00a6590a7918abb18f762243de115258bcad838` | 32923960 |
| browser 151.0.7922.34 | linux arm64 | [chromium-headless-shell-linux-arm64.zip](https://cdn.playwright.dev/builds/chromium/1234/chromium-headless-shell-linux-arm64.zip) | `b03443e1e1a60d06e07b6cdfe650b8c2bfcbb3db497d2b652f73dc6912f4ae15` | 116380215 |
| browser 151.0.7922.34 | linux arm64 | [ffmpeg-linux-arm64.zip](https://cdn.playwright.dev/builds/ffmpeg/1011/ffmpeg-linux-arm64.zip) | `2628c03f05318ff812c8c9baaf207dea2ddf53e818c0dc936714b0fbe3afb009` | 1717234 |
| java 17.0.20.1+1 | linux arm64 | [OpenJDK17U-jre_aarch64_linux_hotspot_17.0.20.1_1.tar.gz](https://github.com/adoptium/temurin17-binaries/releases/download/jdk-17.0.20.1%2B1/OpenJDK17U-jre_aarch64_linux_hotspot_17.0.20.1_1.tar.gz) | `b8efcd5acc9109fe8d35bed132499643048a257b4f6042906ece37d03c839d77` | 45989435 |
| verapdf 1.30.2 | linux arm64 | [verapdf-greenfield-1.30.2-installer.zip](https://software.verapdf.org/rel/1.30/verapdf-greenfield-1.30.2-installer.zip) | `6cc6341cb1af644044054b81f00a6590a7918abb18f762243de115258bcad838` | 32923960 |
