package com.faero.foreground;

import android.content.Intent;
import android.os.Build;

import org.apache.cordova.CallbackContext;
import org.apache.cordova.CordovaPlugin;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * FaeroForegroundPlugin — Cordova bridge
 * ───────────────────────────────────────
 * Exposes three actions to the JavaScript layer:
 *
 *   start  (opts: BotStatus) → starts FaeroForegroundService
 *   update (opts: BotStatus) → sends ACTION_UPDATE to the running service
 *   stop   ()                → sends ACTION_STOP  to the running service
 *
 * BotStatus keys (all optional):
 *   state      String   IDLE / MINING / COMBAT / ESCAPING …
 *   health     int      0–20
 *   food       int      0–20
 *   server     String   "mc.example.com:25565"
 *   dimension  String   "overworld" / "nether" / "the_end"
 */
public class FaeroForegroundPlugin extends CordovaPlugin {

    @Override
    public boolean execute(String action, JSONArray args, CallbackContext cb)
            throws JSONException {

        switch (action) {
            case "start":
                return doStart(args.optJSONObject(0), cb);
            case "stop":
                return doStop(cb);
            case "update":
                return doUpdate(args.optJSONObject(0), cb);
            default:
                return false;
        }
    }

    // ── Action handlers ───────────────────────────────────────────────────

    private boolean doStart(final JSONObject opts, final CallbackContext cb) {
        cordova.getActivity().runOnUiThread(() -> {
            try {
                Intent intent = buildIntent(FaeroForegroundService.ACTION_START, opts);
                launchForegroundService(intent);
                cb.success();
            } catch (Exception e) {
                cb.error("FaeroForeground.start: " + e.getMessage());
            }
        });
        return true;
    }

    private boolean doUpdate(final JSONObject opts, final CallbackContext cb) {
        cordova.getActivity().runOnUiThread(() -> {
            try {
                Intent intent = buildIntent(FaeroForegroundService.ACTION_UPDATE, opts);
                // UPDATE uses startService (not startForegroundService) because the
                // service is already running and we just want to send it new data.
                cordova.getContext().startService(intent);
                cb.success();
            } catch (Exception e) {
                cb.error("FaeroForeground.update: " + e.getMessage());
            }
        });
        return true;
    }

    private boolean doStop(final CallbackContext cb) {
        cordova.getActivity().runOnUiThread(() -> {
            try {
                Intent intent = new Intent(cordova.getContext(), FaeroForegroundService.class)
                    .setAction(FaeroForegroundService.ACTION_STOP);
                cordova.getContext().startService(intent);
                cb.success();
            } catch (Exception e) {
                cb.error("FaeroForeground.stop: " + e.getMessage());
            }
        });
        return true;
    }

    // ── Helpers ───────────────────────────────────────────────────────────

    /**
     * Build an Intent for FaeroForegroundService, populating extras from
     * the JSON options object (all keys are optional).
     */
    private Intent buildIntent(String action, JSONObject opts) throws JSONException {
        Intent intent = new Intent(cordova.getContext(), FaeroForegroundService.class)
            .setAction(action);

        if (opts != null) {
            if (opts.has("state"))     intent.putExtra("state",     opts.getString("state"));
            if (opts.has("health"))    intent.putExtra("health",    opts.getInt("health"));
            if (opts.has("food"))      intent.putExtra("food",      opts.getInt("food"));
            if (opts.has("server"))    intent.putExtra("server",    opts.getString("server"));
            if (opts.has("dimension")) intent.putExtra("dimension", opts.getString("dimension"));
        }
        return intent;
    }

    /**
     * On API 26+ the OS requires startForegroundService() for services that
     * will call startForeground().  On older APIs the normal startService()
     * is used.
     */
    private void launchForegroundService(Intent intent) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            cordova.getContext().startForegroundService(intent);
        } else {
            cordova.getContext().startService(intent);
        }
    }
}
