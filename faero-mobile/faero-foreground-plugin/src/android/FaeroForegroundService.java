package com.faero.foreground;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.util.Log;

/**
 * FaeroForegroundService
 * ──────────────────────
 * An Android foreground Service that keeps the FAERO bot process alive
 * when the screen is off or the app is backgrounded.
 *
 * A persistent status-bar notification is shown at all times while the
 * service is running, preventing Android from killing the process.
 *
 * Notification layout:
 *   ┌─────────────────────────────────────────────────────────┐
 *   │ [icon]  FAERO • MINING                      [ongoing]   │
 *   │         HP 20/20  ·  Food 18/20  ·  overworld           │
 *   │         mc.example.com:25565          [Disconnect]       │
 *   └─────────────────────────────────────────────────────────┘
 *
 * Intents handled (via onStartCommand):
 *   ACTION_START  — start service + show notification (also used for initial data)
 *   ACTION_UPDATE — re-build and update notification without restarting
 *   ACTION_STOP   — dismiss notification and stop the service
 *
 * Extra keys for Intent payloads:
 *   "state"      String  — bot state label (IDLE / MINING / COMBAT …)
 *   "health"     int     — HP, 0-20
 *   "food"       int     — food, 0-20
 *   "server"     String  — server address shown as notification sub-text
 *   "dimension"  String  — current dimension (overworld / nether / the_end)
 *
 * NOTE ON NOTIFICATION ICON
 * Replace android.R.drawable.ic_menu_compass with your own white-silhouette
 * PNG resource.  Add it to platforms/android/app/src/main/res/drawable/ and
 * reference it as R.drawable.ic_faero_notif — then update the setSmallIcon()
 * call below.
 */
public class FaeroForegroundService extends Service {

    private static final String TAG = "FaeroFgService";

    static final String CHANNEL_ID   = "faero_service_v1";
    static final int    NOTIF_ID     = 1337;

    static final String ACTION_START  = "com.faero.bot.START";
    static final String ACTION_STOP   = "com.faero.bot.STOP";
    static final String ACTION_UPDATE = "com.faero.bot.UPDATE";

    // ── Live state (updated by ACTION_START and ACTION_UPDATE) ────────────
    private String _state  = "STARTING";
    private int    _health = 20;
    private int    _food   = 20;
    private String _server = "";
    private String _dim    = "overworld";

    // ── Lifecycle ─────────────────────────────────────────────────────────

    @Override
    public void onCreate() {
        super.onCreate();
        createNotificationChannel();
        Log.d(TAG, "Service created");
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        // Guard against null intent (service restarted by OS after kill)
        if (intent != null) {
            String action = intent.getAction();

            if (ACTION_STOP.equals(action)) {
                Log.d(TAG, "ACTION_STOP received — stopping service");
                saveRunningPref(false);   // clear boot-restart flag on clean stop
                stopForeground(true);
                stopSelf();
                return START_NOT_STICKY;
            }

            // ACTION_START or ACTION_UPDATE — apply new state from extras
            if (intent.hasExtra("state"))     _state  = intent.getStringExtra("state");
            if (intent.hasExtra("health"))    _health = intent.getIntExtra("health", _health);
            if (intent.hasExtra("food"))      _food   = intent.getIntExtra("food",   _food);
            if (intent.hasExtra("server"))    _server = intent.getStringExtra("server");
            if (intent.hasExtra("dimension")) _dim    = intent.getStringExtra("dimension");

            // Persist flag so FaeroBootReceiver can restart after device reboot
            if (ACTION_START.equals(action)) saveRunningPref(true);
        }

        Notification notif = buildNotification();

        // API 29+ requires passing foreground service type to startForeground()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIF_ID, notif, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
        } else {
            startForeground(NOTIF_ID, notif);
        }

        // START_STICKY → OS restarts the service after it is killed, passing
        // a null intent so we restore the previous notification state.
        return START_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null; // Not a bound service
    }

    @Override
    public void onDestroy() {
        super.onDestroy();
        Log.d(TAG, "Service destroyed");
    }

    /**
     * Persist "service was running" + last server address into SharedPreferences
     * so FaeroBootReceiver can read it after the device reboots.
     */
    private void saveRunningPref(boolean running) {
        SharedPreferences.Editor editor =
            getSharedPreferences("faero_prefs", MODE_PRIVATE).edit();
        editor.putBoolean("service_was_running", running);
        editor.putString("last_server", running ? (_server != null ? _server : "") : "");
        editor.apply();
        Log.d(TAG, "saveRunningPref: running=" + running + " server=" + _server);
    }

    // ── Notification builder ──────────────────────────────────────────────

    private Notification buildNotification() {
        int piFlags = PendingIntent.FLAG_UPDATE_CURRENT |
                      (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M
                          ? PendingIntent.FLAG_IMMUTABLE : 0);

        // Tap → reopen the app
        Intent launchIntent = getPackageManager()
            .getLaunchIntentForPackage(getPackageName());
        if (launchIntent == null) launchIntent = new Intent();
        PendingIntent tapPI = PendingIntent.getActivity(this, 0, launchIntent, piFlags);

        // "Disconnect" action → stop the service (bot bridge will detect this)
        Intent stopIntent = new Intent(this, FaeroForegroundService.class)
            .setAction(ACTION_STOP);
        PendingIntent stopPI = PendingIntent.getService(this, 1, stopIntent, piFlags);

        // Notification text — Unicode middle dot U+00B7 as separator
        String title   = "FAERO \u2022 " + _state;
        String content = "HP "   + _health + "/20  \u00b7  "
                       + "Food " + _food   + "/20  \u00b7  " + _dim;
        String subtext = (_server != null && !_server.isEmpty()) ? _server : "Bot active";

        Notification.Builder b;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            b = new Notification.Builder(this, CHANNEL_ID);
        } else {
            @SuppressWarnings("deprecation")
            Notification.Builder legacyB = new Notification.Builder(this)
                .setPriority(Notification.PRIORITY_LOW);
            b = legacyB;
        }

        // ── Swap android.R.drawable.ic_menu_compass for your own icon ────
        // e.g.  b.setSmallIcon(R.drawable.ic_faero_notif)
        b.setSmallIcon(android.R.drawable.ic_menu_compass)
         .setContentTitle(title)
         .setContentText(content)
         .setSubText(subtext)
         .setContentIntent(tapPI)
         .setOngoing(true)
         .setCategory(Notification.CATEGORY_SERVICE)
         .setVisibility(Notification.VISIBILITY_PUBLIC)
         .addAction(android.R.drawable.ic_delete, "Disconnect", stopPI);

        // API 31+: show the notification immediately (don't defer)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            b.setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE);
        }

        return b.build();
    }

    // ── Notification channel (required Android 8+) ────────────────────────

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel ch = new NotificationChannel(
                CHANNEL_ID,
                "FAERO Bot Service",
                NotificationManager.IMPORTANCE_LOW   // silent — no sound/vibration
            );
            ch.setDescription("FAERO bot live status. Tap to open the controller.");
            ch.setShowBadge(false);
            ch.enableVibration(false);
            ch.enableLights(false);
            ch.setSound(null, null);

            NotificationManager nm =
                (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
            if (nm != null) nm.createNotificationChannel(ch);
        }
    }
}
