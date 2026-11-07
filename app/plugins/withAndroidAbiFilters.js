const { withAppBuildGradle } = require('expo/config-plugins');

// React Native's architecture flag controls CMake, but third-party AARs can
// still contribute libraries for every ABI. Apply the same selection to APKs.
const marker = '// FABRIC_ANDROID_ABI_FILTERS';
module.exports = function withAndroidAbiFilters(config) {
  return withAppBuildGradle(config, (mod) => {
    if (mod.modResults.language !== 'groovy') {
      throw new Error('FabriC++ ABI filters require the Expo Groovy Android template.');
    }
    if (!mod.modResults.contents.includes(marker)) {
      mod.modResults.contents += `
${marker}
android {
    def fabricAbis = (findProperty('reactNativeArchitectures') ?: 'armeabi-v7a,arm64-v8a,x86,x86_64').split(',').collect { it.trim() }
    defaultConfig {
        ndk {
            abiFilters.clear()
            abiFilters.addAll(fabricAbis)
        }
    }
    packagingOptions {
        jniLibs {
            (['armeabi', 'armeabi-v7a', 'arm64-v8a', 'x86', 'x86_64', 'mips', 'mips64', 'riscv64'] - fabricAbis).each { abi ->
                excludes.add("lib/" + abi + "/**")
            }
        }
    }
}
`;
    }
    return mod;
  });
};
