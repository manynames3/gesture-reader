const { execFileSync } = require("node:child_process");
const { join } = require("node:path");
const cameraUsage = "Gesture Reader uses the camera to turn PDF pages with palm swipes or head tilts. Video stays on your Mac.";

module.exports = {
  packagerConfig: {
    asar: true,
    name: "Gesture Reader",
    executableName: "Gesture Reader",
    appBundleId: "com.gesturereader.desktop",
    icon: "electron/assets/GestureReader",
    usageDescription: {
      Camera: cameraUsage,
    },
    extendInfo: {
      NSCameraUsageDescription: cameraUsage,
    },
    ignore(filePath) {
      if (!filePath) return false;
      return ![
        /^\/package\.json$/,
        /^\/electron(?:\/|$)/,
        /^\/dist(?:\/client(?:\/|$)|$)/,
      ].some((pattern) => pattern.test(filePath));
    },
  },
  makers: [
    {
      name: "@electron-forge/maker-dmg",
      platforms: ["darwin"],
      config: {
        name: "Gesture Reader",
        format: "ULFO",
      },
    },
    {
      name: "@electron-forge/maker-zip",
      platforms: ["darwin"],
    },
  ],
  hooks: {
    postPackage: async (_forgeConfig, packageResult) => {
      if (packageResult.platform !== "darwin") return;
      for (const outputPath of packageResult.outputPaths) {
        const appPath = join(outputPath, "Gesture Reader.app");
        execFileSync(
          "/usr/bin/codesign",
          [
            "--force",
            "--deep",
            "--sign",
            "-",
            "--timestamp=none",
            appPath,
          ],
          { stdio: "inherit" },
        );
      }
    },
  },
};
