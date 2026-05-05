package com.faero.foreground;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import android.util.Log;

/**
 * FaeroBootReceiver
 * ─────────────────
 * Listens for BOOT_COMPLETED (and the HTC/OnePlus equivalent
 * QUICKBOOT_POWERON) and automatically restarts the FAERO foreground
 * service if it was running when the device was last shut down.
 *
 * How it decides whether to restart:
 *   FaeroForegroundService writes the boolean "service_was_running" and the
 *   string "last_server" to a SharedPreferences file called "faero_prefs"
 *   every time it starts, updates, or stops.  FaeroBootReceiver reads that
 *   flag on boot.  If true, it re-starts the service so Android keeps the
 *   app process alive while the user re-opens the controller UI and
 *   reconnects to the Minecraft server.
 *
 * Required manifest entries (added by plugin.xml):
 *   <uses-permission android:name="android.permission.RECEIVE_BOOT_COMPLETED" />
 *   <receiver android:name="...FaeroBootReceiver" android:exported="true">
 *       <intent-filter>
 *           <action android:name="android.intent.action.BOOT_COMPLETED" />
 *           <action android:name="android.intent.action.QUICKBOOT_POWERON" />
 *       </intent-filter>
 *   </receiver>
 */
public class FaeroBootReceiver extends BroadcastReceiver {

    private static final String TAG        = "FaeroBootReceiver";
    private static final String PREFS_NAME = "faero_prefs";
    private static final String KEY_RUNNING = "service_was_running";
    private static final String KEY_SERVER  = "last_server";

    @Override
    public void onReceive(Context context, Intent intent) {
        final String action = intent == null ? null : intent.getAction();

        // Only react to device boot events
        if (!Intent.ACTION_BOOT_COMPLETED.equals(action) &&
            !"android.intent.action.QUICKBOOT_POWERON".equals(action)) {
            return;
        }

        Log.d(TAG, "Boot broadcast received: " + action);

        SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        boolean wasRunning = prefs.getBoolean(KEY_RUNNING, false);

        if (!wasRunning) {
            Log.d(TAG, "Service was not running before reboot — not restarting");
            return;
        }

        String lastServer = prefs.getString(KEY_SERVER, "");
        Log.d(TAG, "Restarting foreground service (last server: " + lastServer + ")");

        Intent serviceIntent = new Intent(context, FaeroForegroundService.class)
            .setAction(FaeroForegroundService.ACTION_START)
            .putExtra("state",     "RECONNECTING")
            .putExtra("health",    20)
            .putExtra("food",      20)
            .putExtra("server",    lastServer)
            .putExtra("dimension", "overworld");

        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(serviceIntent);
            } else {
                context.startService(serviceIntent);
            }
            Log.d(TAG, "Foreground service restart requested successfully");
        } catch (Exception e) {
            Log.e(TAG, "Failed to restart foreground service: " + e.getMessage());
        }
    }
}
