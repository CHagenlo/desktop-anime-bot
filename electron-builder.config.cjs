module.exports = {
  appId: 'io.github.chagenlo.desktopanimebot',
  productName: 'Desktop Anime Bot',
  executableName: 'Desktop Anime Bot',
  directories: { output: 'dist', buildResources: 'assets' },
  asar: true,
  npmRebuild: false,
  forceCodeSigning: false,
  publish: null,
  files: [
    'src/**/*',
    'renderer/**/*',
    'assets/icon.png',
    'package.json',
    '!src/native/**/*.ps1',
    '!src/native/**/*.cs',
    '!**/*.map'
  ],
  extraResources: [{ from: 'build/native/desktop-window-helper.exe', to: 'native/desktop-window-helper.exe' }],
  // Three's runtime addons live under examples; the builder otherwise excludes that directory.
  onNodeModuleFile(file) {
    if (/(?:^|\/)node_modules\/three\/examples(?:\/|$)/.test(file.replace(/\\/g, '/'))) return true;
    return undefined;
  },
  win: {
    target: [{ target: 'nsis', arch: ['x64'] }, { target: 'portable', arch: ['x64'] }],
    icon: 'assets/app-icon.ico',
    requestedExecutionLevel: 'asInvoker',
    signExecutable: false,
    signAndEditExecutable: true
  },
  nsis: {
    artifactName: 'Desktop-Anime-Bot-Setup-${version}-${arch}.${ext}',
    oneClick: true,
    perMachine: false,
    packElevateHelper: false,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    runAfterFinish: true,
    deleteAppDataOnUninstall: false
  },
  portable: {
    artifactName: 'Desktop-Anime-Bot-Portable-${version}-${arch}.${ext}',
    requestExecutionLevel: 'user'
  }
};
