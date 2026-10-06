plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.uasier.herdrplus"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.uasier.herdrplus"
        minSdk = 26
        targetSdk = 34
        versionCode = 10
        versionName = "0.2.7"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
}

val syncWeb = tasks.register<Copy>("syncWeb") {
    from(rootProject.file("../relay/static"))
    into(layout.projectDirectory.dir("src/main/assets/www"))
}

tasks.named("preBuild").configure { dependsOn(syncWeb) }
