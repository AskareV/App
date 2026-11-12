package com.askarev.misfinanzas;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.List;
import org.junit.Test;

/**
 * La lectura en segundo plano debe dar el mismo monto y tipo que la de la app
 * con los mismos avisos de ejemplo (tests/notices.tsv, en la raíz del proyecto).
 */
public class NoticeAmountTest {

    private static File findCases() {
        File dir = new File(System.getProperty("user.dir")).getAbsoluteFile();
        while (dir != null) {
            File f = new File(dir, "tests/notices.tsv");
            if (f.isFile()) return f;
            dir = dir.getParentFile();
        }
        throw new IllegalStateException("No encuentro tests/notices.tsv");
    }

    @Test
    public void readsTheSameExamplesAsTheApp() throws IOException {
        List<String> lines = Files.readAllLines(findCases().toPath(), StandardCharsets.UTF_8);
        int checked = 0;
        for (String line : lines) {
            if (line.isEmpty() || line.startsWith("#")) continue;
            String[] c = line.split("\t", -1);
            String title = c[0], text = c[1], kind = c[2], amount = c[3];
            NoticeAmount r = NoticeAmount.parse(title, text);
            if (kind.equals("-")) {
                assertNull("no es un pago: " + text, r);
            } else {
                assertNotNull("sin resultado: " + text, r);
                assertEquals("tipo: " + text, kind.equals("ingresos"), r.incoming);
                assertEquals("monto: " + text, Double.parseDouble(amount), r.amount, 0.0001);
            }
            checked++;
        }
        assertEquals("cantidad de casos leídos", 38, checked);
    }

    @Test
    public void parsesNumberFormats() {
        assertEquals(1234.5, NoticeAmount.parseMoney("1.234,50"), 0.0001);
        assertEquals(1234.5, NoticeAmount.parseMoney("1,234.50"), 0.0001);
        assertEquals(1500, NoticeAmount.parseMoney("1.500"), 0.0001);
        assertEquals(0.5, NoticeAmount.parseMoney("0,50"), 0.0001);
        assertEquals(0.5, NoticeAmount.parseMoney("0.500"), 0.0001);
        assertNull(NoticeAmount.parseMoney("0"));
        assertNull(NoticeAmount.parseMoney("100000000"));
    }

    @Test
    public void normalizeKeepsPositions() {
        String s = "Débito de Bs. 50";
        assertEquals(s.length(), NoticeAmount.normalize(s).length());
        assertEquals("debito de bs. 50", NoticeAmount.normalize(s));
    }
}
