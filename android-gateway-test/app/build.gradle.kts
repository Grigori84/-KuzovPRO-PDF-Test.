plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "ru.kuzovpro.gatewaytest"
    compileSdk = 35
    buildToolsVersion = "35.0.0"
    defaultConfig {
        applicationId = "ru.kuzovpro.gatewaytest"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "0.1-test"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    testOptions.unitTests.all {
        it.systemProperty("gateway.auth.checker", rootProject.file("tools/verify-protocol.cjs").absolutePath)
    }
    lint { abortOnError = true; checkReleaseBuilds = false }
}

dependencies {
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303")
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
    androidTestImplementation("androidx.test:runner:1.6.2")
}
