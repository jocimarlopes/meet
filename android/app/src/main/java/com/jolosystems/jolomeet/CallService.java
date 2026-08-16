package com.jolosystems.jolomeet;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;

import androidx.core.app.NotificationCompat;

/**
 * Mantém a conversa viva com o aplicativo em segundo plano.
 *
 * Não é firula: desde o Android 9, aplicativo em segundo plano simplesmente
 * não acessa o microfone, a não ser que exista um serviço em primeiro plano
 * declarado com o tipo `microphone`. Sem ele o áudio é cortado e o processo é
 * congelado — medido antes desta classe existir, a chamada morria em menos de
 * 30 segundos depois de sair do app.
 *
 * A notificação permanente é obrigatória, e é justo que seja: ninguém deveria
 * poder deixar um microfone aberto sem aviso na tela.
 */
public class CallService extends Service {

    private static final String CANAL = "chamada_em_andamento";
    private static final int NOTIFICACAO = 42;

    @Override
    public void onCreate() {
        super.onCreate();
        criarCanal();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        Intent abrir = new Intent(this, MainActivity.class);
        abrir.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);

        PendingIntent toque = PendingIntent.getActivity(
            this,
            0,
            abrir,
            PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT
        );

        Notification aviso = new NotificationCompat.Builder(this, CANAL)
            .setContentTitle("Conversa em andamento")
            .setContentText("Toque para voltar ao Jolo Meet")
            .setSmallIcon(R.drawable.ic_splash)
            .setContentIntent(toque)
            .setOngoing(true)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build();

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            // O tipo é o que autoriza o microfone a continuar aberto.
            startForeground(NOTIFICACAO, aviso, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE);
        } else {
            startForeground(NOTIFICACAO, aviso);
        }

        // Sem `START_STICKY`: se o sistema matar o serviço, a conversa já
        // acabou de qualquer jeito — ressuscitar sozinho só deixaria uma
        // notificação órfã.
        return START_NOT_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private void criarCanal() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return;
        }
        NotificationChannel canal = new NotificationChannel(
            CANAL,
            "Conversa em andamento",
            NotificationManager.IMPORTANCE_LOW
        );
        canal.setDescription("Mantém o áudio da conversa enquanto o app está em segundo plano.");
        canal.setShowBadge(false);
        getSystemService(NotificationManager.class).createNotificationChannel(canal);
    }
}
