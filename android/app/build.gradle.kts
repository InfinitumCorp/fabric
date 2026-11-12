import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

kotlin {
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_17)
    }
}

android {
    namespace = "app.infinitumfabric.client"
    compileSdk = 35

    defaultConfig {
        applicationId = "app.infinitumfabric.client"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        vectorDrawables { useSupportLibrary = true }
        // Cumulus ID. Override with -PcidIssuer=https://<mirror> for a Russia-reachable issuer.
        val cidIssuer = (project.findProperty("cidIssuer") as String?) ?: "https://id.cumuluscloud.app"
        require(cidIssuer.startsWith("https://")) { "cidIssuer must be HTTPS" }
        buildConfigField("String", "CID_ISSUER", "\"$cidIssuer\"")
        buildConfigField("String", "CID_CLIENT", "\"fabric\"")
        buildConfigField("String", "CID_REDIRECT", "\"https://infinitumfabric.app/cid/return\"")
    }

    // Release signing: keystore and password files stay outside the repo.
    // -PfabricKeystore=<path to .jks> -PfabricStorePassFile=<path to password file> (key password = store password).
    val releaseKeystore = (project.findProperty("fabricKeystore") as String?)?.let { file(it) }
    val releasePassFile = (project.findProperty("fabricStorePassFile") as String?)?.let { file(it) }
    if (releaseKeystore != null && releasePassFile != null && releaseKeystore.exists() && releasePassFile.exists()) {
        signingConfigs {
            create("release") {
                val pass = releasePassFile.readText().trim()
                storeFile = releaseKeystore
                storePassword = pass
                keyAlias = (project.findProperty("fabricKeyAlias") as String?) ?: "fabric"
                keyPassword = pass
            }
        }
    }

    buildTypes {
        debug {
            isMinifyEnabled = false
            isDebuggable = true
        }
        release {
            signingConfigs.findByName("release")?.let { signingConfig = it }
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    packaging {
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
        }
    }

    lint {
        abortOnError = true
        checkReleaseBuilds = true
    }

    // One universal debug APK, including arm64-v8a. No ABI splits.
    splits {
        abi { isEnable = false }
    }
}

dependencies {
    val composeBom = platform("androidx.compose:compose-bom:2025.02.00")
    implementation(composeBom)
    androidTestImplementation(composeBom)

    implementation("androidx.core:core-ktx:1.16.0")
    implementation("androidx.activity:activity-compose:1.10.1")
    implementation("androidx.browser:browser:1.8.0")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.9.2")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.9.2")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.9.2")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.material3:material3")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.2")
    // Amplitude analytics (official SDK). Page views/sessions only; see FabricApplication.
    implementation("com.amplitude:analytics-android:1.37.1")

    debugImplementation("androidx.compose.ui:ui-tooling")
    debugImplementation("androidx.compose.ui:ui-test-manifest")

    testImplementation("junit:junit:4.13.2")
    testImplementation("com.squareup.okhttp3:mockwebserver:4.12.0")
    testImplementation("org.json:json:20250517")

    androidTestImplementation("androidx.test.ext:junit:1.2.1")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.6.1")
    androidTestImplementation("androidx.compose.ui:ui-test-junit4")
}
