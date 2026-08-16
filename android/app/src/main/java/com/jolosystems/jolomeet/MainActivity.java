package com.jolosystems.jolomeet;

import android.os.Bundle;
import android.view.WindowManager;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    /**
     * Nada da conversa sai desta janela.
     *
     * FLAG_SECURE bloqueia print, gravação de tela, espelhamento e a miniatura
     * que apareceria no alternador de apps. É o motivo de existir a versão
     * nativa: na web o navegador não deixa impedir nenhuma dessas coisas.
     *
     * Não é absoluto — aparelho com root ou uma câmera apontada para a tela
     * passam por cima. Ele corta o caminho fácil, que é o do próprio sistema.
     */
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setFlags(
            WindowManager.LayoutParams.FLAG_SECURE,
            WindowManager.LayoutParams.FLAG_SECURE
        );
    }
}
