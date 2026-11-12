package com.askarev.misfinanzas;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Los plugins propios se registran antes de que arranque el puente con la parte web
        registerPlugin(PaymentCapturePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
