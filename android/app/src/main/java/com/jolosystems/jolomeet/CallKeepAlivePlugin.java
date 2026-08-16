package com.jolosystems.jolomeet;

import android.content.Intent;

import androidx.core.content.ContextCompat;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Ponte mínima para o app ligar e desligar o serviço de chamada.
 *
 * Só existe porque o serviço precisa ser iniciado com o aplicativo ainda em
 * primeiro plano — do Android 12 em diante não dá para subir um serviço de
 * primeiro plano depois que o app já foi para trás.
 */
@CapacitorPlugin(name = "CallKeepAlive")
public class CallKeepAlivePlugin extends Plugin {

    @PluginMethod
    public void start(PluginCall call) {
        ContextCompat.startForegroundService(
            getContext(),
            new Intent(getContext(), CallService.class)
        );
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        getContext().stopService(new Intent(getContext(), CallService.class));
        call.resolve();
    }
}
