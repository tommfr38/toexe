import javax.swing.*;

public class HelloJava {
    public static void main(String[] args) {
        if (args.length > 0 && args[0].equals("--print")) {
            System.out.println("Hello from a Java app");
            return;
        }
        SwingUtilities.invokeLater(() -> {
            JFrame f = new JFrame("HelloJava");
            f.add(new JLabel("Hello from a Java app", SwingConstants.CENTER));
            f.setSize(320, 120);
            f.setLocationRelativeTo(null);
            f.setDefaultCloseOperation(JFrame.EXIT_ON_CLOSE);
            f.setVisible(true);
        });
    }
}
