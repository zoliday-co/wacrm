package com.wacrm.inbox

import android.app.Application
import com.wacrm.inbox.data.AppContainer

class WacrmApp : Application() {
    lateinit var container: AppContainer
        private set

    override fun onCreate() {
        super.onCreate()
        container = AppContainer(this)
    }
}
