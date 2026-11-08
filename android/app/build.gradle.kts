plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// A interface do APK é a mesma do controle web (pasta /web na raiz do projeto).
val webAssetsDir = layout.buildDirectory.dir("generated/webassets")
val copyWebAssets by tasks.registering(Sync::class) {
    from(rootProject.file("../web"))
    into(webAssetsDir.map { it.dir("web") })
}

// Assinatura de release: vem de variáveis de ambiente (GitHub Actions). Sem elas, usa a chave de debug.
val releaseStoreFile = System.getenv("DIAKOPLAYER_SIGNING_STORE_FILE")

android {
    namespace = "org.diakoplayer.remote"
    compileSdk = 35

    defaultConfig {
        applicationId = "org.diakoplayer.remote"
        minSdk = 24
        targetSdk = 35
        versionCode = System.getenv("DIAKOPLAYER_VERSION_CODE")?.toInt() ?: 1
        versionName = System.getenv("DIAKOPLAYER_VERSION_NAME") ?: "1.0.0"
    }
    signingConfigs {
        if (releaseStoreFile != null) {
            create("release") {
                storeFile = file(releaseStoreFile)
                storePassword = requireNotNull(System.getenv("DIAKOPLAYER_SIGNING_STORE_PASSWORD"))
                keyAlias = requireNotNull(System.getenv("DIAKOPLAYER_SIGNING_KEY_ALIAS"))
                keyPassword = requireNotNull(System.getenv("DIAKOPLAYER_SIGNING_KEY_PASSWORD"))
            }
        }
    }
    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName(if (releaseStoreFile != null) "release" else "debug")
        }
    }
    sourceSets["main"].assets.srcDir(webAssetsDir)
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

tasks.named("preBuild") { dependsOn(copyWebAssets) }
