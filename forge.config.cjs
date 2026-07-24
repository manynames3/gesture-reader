const { execFileSync } = require("node:child_process");
const { join } = require("node:path");

module.exports = {
  packagerConfig: {
    asar: true,
    name: "Gesture Reader",
    executableName: "Gesture Reader",
    appBundleId: "com.gesturereader.desktop",
    icon: "electron/assets/GestureReader",
    usageDescription: {
      Camera:
        "Gesture Reader uses the camera for on-device hand gestures that turn PDF pages.",
    },
    extendInfo: {
      NSCameraUsageDescription:
        "Gesture Reader uses the camera for on-device hand gestures that turn PDF pages.",
    },
    ignore(filePath) {
      if (!filePath) return false;
      return ![
        /^\/package\.json$/,
        /^\/electron(?:\/|$)/,
        /^\/dist(?:\/|$)/,
        /^\/public(?:\/|$)/,
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
