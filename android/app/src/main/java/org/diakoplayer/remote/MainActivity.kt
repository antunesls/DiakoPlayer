package org.diakoplayer.remote

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Context
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Bundle
import android.view.KeyEvent
import android.view.View
import android.view.WindowInsets
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import org.json.JSONArray
import org.json.JSONObject
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.net.SocketTimeoutException
import java.util.concurrent.Executors

/**
 * Casca nativa do controle: mostra a interface web empacotada (pasta /web) num WebView e
 * oferece o que o navegador não consegue: descoberta do PC por UDP, botões de volume e tela ligada.
 */
class MainActivity : Activity() {

    private lateinit var webView: WebView
    private val io = Executors.newSingleThreadExecutor()

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val root = FrameLayout(this)
        root.setBackgroundColor(0xFF0B0B0F.toInt())
        webView = WebView(this)
        root.addView(webView, FrameLayout.LayoutParams(-1, -1))
        setContentView(root)

        // Respeita barra de status e de navegação (Android 15 força edge-to-edge).
        root.setOnApplyWindowInsetsListener { v, insets ->
            if (Build.VERSION.SDK_INT >= 30) {
                val b = insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.ime())
                v.setPadding(b.left, b.top, b.right, b.bottom)
            } else {
                @Suppress("DEPRECATION")
                v.setPadding(
                    insets.systemWindowInsetLeft, insets.systemWindowInsetTop,
                    insets.systemWindowInsetRight, insets.systemWindowInsetBottom,
                )
            }
            insets
        }

        with(webView.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            cacheMode = WebSettings.LOAD_NO_CACHE
            allowFileAccess = false
            mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
        }
        webView.overScrollMode = View.OVER_SCROLL_NEVER
        webView.setBackgroundColor(0xFF0B0B0F.toInt())
        webView.addJavascriptInterface(Bridge(), "DiakoNative")
        webView.webViewClient = AssetClient()

        if (savedInstanceState != null) webView.restoreState(savedInstanceState)
        else webView.loadUrl("http://$ASSET_HOST/index.html")
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        webView.saveState(outState)
    }

    // Botões físicos de volume controlam o volume do PC.
    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        val dir = when (event.keyCode) {
            KeyEvent.KEYCODE_VOLUME_UP -> 1
            KeyEvent.KEYCODE_VOLUME_DOWN -> -1
            else -> 0
        }
        if (dir != 0) {
            if (event.action == KeyEvent.ACTION_DOWN) {
                webView.evaluateJavascript("window.diakoVolumeStep && window.diakoVolumeStep($dir)", null)
            }
            return true
        }
        return super.dispatchKeyEvent(event)
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        // Mantém o app vivo em segundo plano em vez de fechar.
        moveTaskToBack(true)
    }

    override fun onDestroy() {
        io.shutdownNow()
        webView.destroy()
        super.onDestroy()
    }

    /** Serve os arquivos de assets/web como se fossem um site http://app.diakoplayer/. */
    private inner class AssetClient : WebViewClient() {
        override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
            val url = request.url
            if (url.host != ASSET_HOST) return null
            var path = url.path?.trimStart('/') ?: ""
            if (path.isEmpty()) path = "index.html"
            if (path.contains("..")) return null
            return try {
                val stream = assets.open("web/$path")
                val mime = when (path.substringAfterLast('.').lowercase()) {
                    "html" -> "text/html"
                    "js" -> "text/javascript"
                    "css" -> "text/css"
                    "json", "webmanifest" -> "application/json"
                    "png" -> "image/png"
                    "svg" -> "image/svg+xml"
                    else -> "application/octet-stream"
                }
                WebResourceResponse(mime, "utf-8", stream)
            } catch (e: Exception) {
                WebResourceResponse("text/plain", "utf-8", 404, "Not Found", emptyMap(), null)
            }
        }

        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            // Links externos (ex.: abrir no YouTube) vão para o navegador.
            if (request.url.host == ASSET_HOST) return false
            try {
                startActivity(android.content.Intent(android.content.Intent.ACTION_VIEW, request.url))
            } catch (_: Exception) {
            }
            return true
        }
    }

    private inner class Bridge {
        @JavascriptInterface
        fun discover() {
            io.execute {
                val found = discoverPlayers()
                val json = JSONObject.quote(found.toString())
                runOnUiThread {
                    webView.evaluateJavascript("window.onDiakoDiscovered && window.onDiakoDiscovered($json)", null)
                }
            }
        }

        @JavascriptInterface
        fun keepScreenOn(on: Boolean) {
            runOnUiThread {
                if (on) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                else window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            }
        }

        @JavascriptInterface
        fun platform(): String = "android"
    }

    /** Envia um broadcast UDP e coleta as respostas dos PCs com DiakoPlayer aberto. */
    private fun discoverPlayers(): JSONArray {
        val result = JSONArray()
        val seen = HashSet<String>()
        val wifi = applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
        val lock = wifi.createMulticastLock("diakoplayer-discovery").apply { setReferenceCounted(false) }
        try {
            lock.acquire()
            DatagramSocket().use { sock ->
                sock.broadcast = true
                sock.soTimeout = 400
                val payload = DISCOVERY_MAGIC.toByteArray()
                val targets = buildList {
                    add(InetAddress.getByName("255.255.255.255"))
                    subnetBroadcast(wifi)?.let { add(it) }
                }
                val deadline = System.currentTimeMillis() + 2000
                var nextSend = 0L
                val buf = ByteArray(2048)
                while (System.currentTimeMillis() < deadline) {
                    val now = System.currentTimeMillis()
                    if (now >= nextSend) {
                        for (t in targets) {
                            try {
                                sock.send(DatagramPacket(payload, payload.size, t, DISCOVERY_PORT))
                            } catch (_: Exception) {
                            }
                        }
                        nextSend = now + 700
                    }
                    try {
                        val packet = DatagramPacket(buf, buf.size)
                        sock.receive(packet)
                        val obj = JSONObject(String(packet.data, 0, packet.length))
                        if (obj.optString("app") != "diakoplayer") continue
                        val host = packet.address.hostAddress ?: continue
                        val key = "$host:${obj.optInt("port")}"
                        if (seen.add(key)) {
                            obj.put("host", host)
                            result.put(obj)
                        }
                    } catch (_: SocketTimeoutException) {
                    } catch (_: Exception) {
                    }
                }
            }
        } catch (_: Exception) {
        } finally {
            if (lock.isHeld) lock.release()
        }
        return result
    }

    @Suppress("DEPRECATION")
    private fun subnetBroadcast(wifi: WifiManager): InetAddress? {
        val dhcp = wifi.dhcpInfo ?: return null
        if (dhcp.ipAddress == 0) return null
        val mask = if (dhcp.netmask != 0) dhcp.netmask else 0x00FFFFFF // padrão /24 (little-endian)
        val bcast = (dhcp.ipAddress and mask) or mask.inv()
        val bytes = ByteArray(4) { i -> (bcast shr (i * 8) and 0xFF).toByte() }
        return InetAddress.getByAddress(bytes)
    }

    companion object {
        private const val ASSET_HOST = "app.diakoplayer"
        private const val DISCOVERY_PORT = 26539
        private const val DISCOVERY_MAGIC = "DIAKOPLAYER_DISCOVER"
    }
}
