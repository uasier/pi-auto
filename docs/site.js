const repo = "https://github.com/uasier/pi-auto";
const arm = document.getElementById("dl-arm");
const intel = document.getElementById("dl-intel");
const note = document.getElementById("dl-note");

fetch("https://api.github.com/repos/uasier/pi-auto/releases/latest")
  .then((response) => {
    if (!response.ok) throw new Error(String(response.status));
    return response.json();
  })
  .then((release) => {
    const assets = release.assets || [];
    const find = (part) => assets.find((asset) => asset.name.includes(part) && asset.name.endsWith(".dmg"));
    const apple = find("aarch64");
    const x64 = find("x64");
    if (apple) arm.href = apple.browser_download_url;
    if (x64) intel.href = x64.browser_download_url;
    if (release.tag_name) {
      note.textContent = `${release.tag_name} · 安装包未签名。首次请右键 App，选择「打开」。`;
    }
  })
  .catch(() => {
    arm.href = `${repo}/releases/latest`;
    intel.href = `${repo}/releases/latest`;
  });
