import java.util.Properties

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
}

// Backend endpoints and keys come from local.properties (never committed).
// See README.md for the required entries.
val localProps = Properties().apply {
    val f = rootProject.file("local.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}

fun stringField(name: String): String {
    val value = localProps.getProperty(name) ?: System.getenv(name) ?: ""
    return "\"${value.trim()}\""
}

android {
    namespace = "com.wacrm.inbox"
    compileSdk {
        version = release(37)
    }

    defaultConfig {
        applicationId = "com.wacrm.inbox"
        minSdk = 26
        targetSdk = 36
        versionCode = 1
        versionName = "1.0"

        buildConfigField("String", "SUPABASE_URL", stringField("SUPABASE_URL"))
        buildConfigField("String", "SUPABASE_ANON_KEY", stringField("SUPABASE_ANON_KEY"))
        buildConfigField("String", "CRM_ORIGIN", stringField("CRM_ORIGIN"))
    }

    buildTypes {
        release {
            optimization {
                enable = false
            }
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_11
        targetCompatibility = JavaVersion.VERSION_11
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
}

dependencies {
    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.compose.material3)
    // Newer Compose BOMs no longer pull the icons artifact transitively.
    implementation(libs.androidx.compose.material.icons.core)
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.ui.graphics)
    implementation(libs.androidx.compose.ui.tooling.preview)
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.lifecycle.process)

    // Supabase: auth (session + persistence), postgrest (reads/updates),
    // realtime (live inbox/thread). Ktor OkHttp is the shared HTTP engine;
    // the same client also does the one non-Supabase call (/api/whatsapp/send).
    implementation(platform(libs.supabase.bom))
    implementation(libs.supabase.auth)
    implementation(libs.supabase.postgrest)
    implementation(libs.supabase.realtime)
    implementation(libs.ktor.client.okhttp)
    implementation(libs.kotlinx.serialization.json)

    implementation(libs.coil.compose)

    testImplementation(libs.junit)
    debugImplementation(libs.androidx.compose.ui.tooling)
}
