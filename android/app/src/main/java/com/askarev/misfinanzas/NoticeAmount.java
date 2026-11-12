package com.askarev.misfinanzas;

import java.text.Normalizer;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Lee el monto en bolivianos y si el dinero salió o entró, a partir del texto de un aviso
 * del banco. Sirve para el aviso propio de la app ("Pagaste Bs. 50,00 · ¿en qué fue?"),
 * que se muestra con la app cerrada.
 *
 * Es una copia de las reglas de la parte web (findAmount, parseMoney y la dirección en
 * parsePaymentNotice, en www/index.html). Las dos se prueban con los mismos casos
 * (tests/notices.tsv): si se cambia una, hay que cambiar la otra.
 */
final class NoticeAmount {

    final boolean incoming;
    final double amount;

    private NoticeAmount(boolean incoming, double amount) {
        this.incoming = incoming;
        this.amount = amount;
    }

    private static final String AMOUNT_TOKEN = "(\\d[\\d.,]*\\d|\\d)";
    /** "Bs 50", "Bs. 50,00", "BOB 50"; no vale si lo que sigue parece una fecha u hora. */
    private static final Pattern AMOUNT_BEFORE = Pattern.compile(
        "(?<![a-z0-9])(?:bs|bob)\\.?\\s*[:.-]?\\s*" + AMOUNT_TOKEN + "(?![\\d/:]|-\\d)"
    );
    /** "50 Bs", "50,00 bolivianos". */
    private static final Pattern AMOUNT_AFTER = Pattern.compile(
        "(?<![\\d/:.,a-z-])" + AMOUNT_TOKEN + "\\s*(?:bs|bob|bolivianos)(?![a-z0-9])"
    );
    /** Números que no son el monto pagado: saldos, números de operación, cuentas… */
    private static final Pattern NOT_THE_AMOUNT = Pattern.compile(
        "(?<![a-z])(?:saldo|disponible|nro|n°|nº|num|numero|operacion|codigo|cod|cuenta|cta|ref|referencia|comprobante|transaccion|tarjeta|celular|telefono|nit)" +
        "(?:[^a-z0-9]+(?:es|de|actual|disponible|total|final|en|su|tu|cuenta)){0,3}[^a-z0-9]*(?:(?:bs|bob)\\.?\\s*[:.-]?\\s*)?$"
    );
    private static final Pattern MONEY_OUT = Pattern.compile(
        "(?<![a-z])(?:pagaste|transferiste|enviaste|compraste|retiraste|debito|debitado|debitada|debitamos|debitaron|compra|retiro|cargo|tu transferencia)(?![a-z])"
    );
    private static final Pattern MONEY_IN = Pattern.compile(
        "(?<![a-z])(?:recibiste|recibio|recibido|recibida|te enviaron|te envio|te transfirieron|te transfirio|te pagaron|te pago|te depositaron|te deposito|te abonaron|abono|abonamos|abonado|abonada|acreditado|acreditada|acredito|acreditamos|acreditacion|deposito recibido)(?![a-z])"
    );
    /** Espacios que la web cuenta como "\s" y Java no (espacio duro, espacio fino…). */
    private static final Pattern UNICODE_SPACES = Pattern.compile("[\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]");
    private static final Pattern COMBINING_MARKS = Pattern.compile("[\\u0300-\\u036f]");

    /** Devuelve el monto y la dirección, o null si el aviso no trae un monto en bolivianos. */
    static NoticeAmount parse(String title, String text) {
        StringBuilder full = new StringBuilder();
        if (title != null && !title.isEmpty()) full.append(title);
        if (text != null && !text.isEmpty()) {
            if (full.length() > 0) full.append('\n');
            full.append(text);
        }
        String norm = normalize(full.toString());
        Double amount = findAmount(norm);
        if (amount == null) return null;
        boolean incoming = !MONEY_OUT.matcher(norm).find() && MONEY_IN.matcher(norm).find();
        return new NoticeAmount(incoming, amount);
    }

    /** Minúsculas y sin tildes, como normalizeText() de la web (sin cambiar la posición de nada). */
    static String normalize(String s) {
        String lower = s.toLowerCase(Locale.ROOT);
        String nfd = Normalizer.normalize(lower, Normalizer.Form.NFD);
        String noMarks = COMBINING_MARKS.matcher(nfd).replaceAll("");
        return UNICODE_SPACES.matcher(noMarks).replaceAll(" ");
    }

    private static final class Candidate {

        final int at;
        final String token;

        Candidate(int at, String token) {
            this.at = at;
            this.token = token;
        }
    }

    private static Double findAmount(String norm) {
        List<Candidate> found = new ArrayList<>();
        Matcher before = AMOUNT_BEFORE.matcher(norm);
        while (before.find()) found.add(new Candidate(before.start(1), before.group(1)));
        Matcher after = AMOUNT_AFTER.matcher(norm);
        while (after.find()) found.add(new Candidate(after.start(1), after.group(1)));
        // Orden estable, igual que en la web: por posición en el texto
        found.sort((a, b) -> Integer.compare(a.at, b.at));
        for (Candidate c : found) {
            String preceding = norm.substring(Math.max(0, c.at - 40), c.at);
            if (NOT_THE_AMOUNT.matcher(preceding).find()) continue;
            Double value = parseMoney(c.token);
            if (value != null) return value;
        }
        return null;
    }

    /** "1.234,50", "1,234.50", "50" o "50,5" → número. */
    static Double parseMoney(String token) {
        String s = token;
        int dot = s.lastIndexOf('.');
        int comma = s.lastIndexOf(',');
        if (dot >= 0 && comma >= 0) {
            // Con los dos signos, el último es el de los decimales
            char dec = dot > comma ? '.' : ',';
            char thousands = dec == '.' ? ',' : '.';
            s = s.replace(String.valueOf(thousands), "");
            int first = s.indexOf(dec);
            if (first >= 0) s = s.substring(0, first) + '.' + s.substring(first + 1);
        } else if (dot >= 0 || comma >= 0) {
            String sep = dot >= 0 ? "\\." : ",";
            String[] parts = s.split(sep, -1);
            String last = parts[parts.length - 1];
            // Un signo seguido de 3 cifras separa miles (1.500); con 1 o 2 cifras, decimales (1.50)
            if (last.length() == 3 && !parts[0].equals("0")) {
                s = String.join("", parts);
            } else {
                StringBuilder intPart = new StringBuilder();
                for (int i = 0; i < parts.length - 1; i++) intPart.append(parts[i]);
                s = intPart + "." + last;
            }
        }
        double n;
        try {
            n = Double.parseDouble(s);
        } catch (NumberFormatException e) {
            return null;
        }
        if (Double.isNaN(n) || Double.isInfinite(n) || n <= 0 || n >= 1e8) return null;
        return Math.round(n * 100) / 100.0;
    }
}
