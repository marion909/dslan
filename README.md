# TWLan-node

Eigener Neubau des TWLan-Backends (Node.js + SQLite). Läuft nativ auf Apple Silicon und auf einem Linux-Server (aaPanel).
Es gibt keine LAN-Sperre; jeder mit Zugang zur URL kann spielen.

## Lokal starten
    npm install
    npm start          # http://localhost:3100
    npm run dev        # startet bei Code-Änderungen neu
    npm test           # Tests
    npx eslint .       # Lint

Der **erste registrierte Account** wird Admin (Bereich `/admin/`).

## Spielumfang
Wirtschaft und alle Gebäude (Abriss, Bauschleife mit Aufschlag und Umsortieren), Rekrutierung, Forschung,
Versammlungsplatz (Angriff, Unterstützung, Truppenübersicht, Simulator, Vorlagen), Kampf mit Moral, Glück, Wall, Rammen,
Katapulten, Nachtbonus, Beute und Spähern, Eroberung per Adelsgeschlecht (Goldmünzen, Zustimmung), Paladin mit Gegenständen,
Markt (Händler, Angebote), mehrere Dörfer (Wechsel, Gruppen, Übersichten), Karte mit Minikarte und Suche, Berichte,
Nachrichten, Rangliste (inkl. Stammeskriege), Stämme (Rechte, Einladungen, Diplomatie, Forum, Ereignisse), Profile, Aufgaben, Erfolge,
Reliquien (sechs Stück, Wirkung auf Produktion, Verteidigung oder Angriff), Premium-Punkte (vom Admin vergeben, für „sofort fertig“), Bewerbungen bei Stämmen, Adelsplaner (Dörfer für den Stamm reservieren), Dörfer-Menü im Kopf, Farbgruppen auf der Karte, Bots, Spielersprache pro Account (23 Sprachen), eigene Schnellleiste, Anmeldeverlauf, Blockliste, Berichte weiterleiten,
Favoriten und Verlauf beim Versammlungsplatz, Truppen und Rohstoffe direkt von der Karte schicken, Weltkarte und Admin-Bereich.

Außerdem: automatische Datenbank-Backups (Admin-Bereich), Wiederherstellungscode fürs Passwort, Browser-Benachrichtigungen,
Berichte mit Ordnern, Filter und öffentlichem Link (`/report/<token>`), Nachrichten-Ordner und Adressbuch-Gruppen,
Stammesforum mit Unterforen und Umfragen, Paladin-Umzug zwischen Dörfern mit Statue, Sitter (Einstellungen → Sitter; der Sitter
arbeitet im Account des Besitzers, kommt aber nicht an Einstellungen, Nachrichten, Premium und Stamm) und die Kirche
(nur wenn `church` in der Weltkonfiguration aktiv ist: außerhalb eines Kirchenbereichs kämpfen Truppen nur mit 50 %).

Bewusst nicht enthalten: Flaggen und „Geheimnis“ (im Original nur Platzhalter ohne Spezifikation), E-Mail-Banner, Chat und Social-Links.
Alle Formeln, die nicht in den Konfigurationsdateien stehen (z. B. Kirchenradius, Bot-Verhalten), sind Schätzungen.

Handy-Ansicht: Smartphones bekommen automatisch einen eigenen Seitenrahmen (feste Kopfleiste mit Dorfwechsel und Rohstoffen,
Schnellzugriffe als Chips, Tab-Leiste unten, Menü-Schublade, Dörfer-Auswahl als Sheet, Karte in Bildschirmgröße mit Touch-Ziehen).
Die Spielseiten selbst sind dieselben. Mit „Desktop-Ansicht“ bzw. „Mobile Ansicht“ (Menü bzw. Fußzeile) lässt sich per Cookie umschalten.

## Mehrere Welten
Jede Welt ist eine eigene Instanz mit eigener Datenbank: `config/worlds/world` nach `config/worlds/<name>` kopieren, dort Werte anpassen und
mit `TW_WORLD=<name> DB_FILE=data/<name>.db PORT=3001 npm start` starten. Accounts gelten pro Welt.

## Bots
Im Admin-Bereich unter „Bots“ legst du fest, wie viele Bots mitspielen (0 bis 200). Bots sind normale Spieler-Accounts, die über dieselben
Spielfunktionen handeln: Sie bauen nach einem Plan, rekrutieren und erforschen, spähen und greifen Dörfer an (nur nach vorherigem Spähen oder
bei Barbarendörfern), unterstützen Stammesmitglieder, handeln auf dem Markt, gründen und besuchen Stämme, schreiben im Forum, beantworten
Nachrichten, lösen Aufgaben, bauen Paladin und Reliquien aus und erobern mit Adelsgeschlechtern. Sie halten sich an Kosten, Bauschleifen,
Bevölkerungsgrenzen, Laufzeiten und Angriffsschutz und können sich nicht anmelden. Einstellbar sind außerdem die Zeit zwischen zwei Zügen,
die Angriffslust, ob echte Spieler angegriffen werden dürfen und ob Bot-Namen den Zusatz „[Bot]“ tragen.

## Geschwindigkeit
`config/server.json` → `speedMultiplier` (oder Umgebungsvariable `TW_SPEED_MULT`) multipliziert die Weltgeschwindigkeit aus
`config/worlds/world/world.json`. Im Admin-Bereich unter „Einstellungen“ lässt sich der Faktor auch zur Laufzeit ändern.
Die Dauer des Angriffsschutzes wird mit dem Faktor mitgeskaliert.

## Auf aaPanel
1. App Store: **Node.js-Versionsmanager** installieren, Node **22.5 oder neuer** wählen (wegen `node:sqlite`).
2. Projektordner hochladen (ohne `node_modules` und `data/`), dort `npm install --omit=dev` ausführen.
3. Website → Node-Projekt hinzufügen: Startbefehl `npm start`, Port z. B. `3100`.
   Umgebungsvariablen: `PORT=3100`, optional `HOST=127.0.0.1` (nur über den Proxy erreichbar),
   `REGISTRATION=closed` (oder im Admin-Bereich sperren), `TW_LANG=de` (Standardsprache).
4. Domain mit Reverse-Proxy auf `127.0.0.1:3100` und SSL (Let's Encrypt) einrichten. Das Session-Cookie wird dann automatisch als `Secure` gesetzt.
5. Backup: nur der Ordner `data/` (SQLite-Datei `twlan.db`).
6. Bilder fehlen (404)? Dann ist meist der Upload unvollständig (viele kleine Dateien in `public/graphic`). Im Projektordner
   `node scripts/check-assets.js` ausführen, es listet fehlende Dateien; beim Start steht dieselbe Warnung im Log.
   Den Ordner `public/` (am besten als ZIP) erneut hochladen und entpacken. Mit `curl -I https://<domain>/graphic/index/topbar-main.png` lässt sich das prüfen.

## Aufbau
    server.js              Start, Tick für ankommende Befehle
    src/app.js             Express, Login/Registrierung, Sitzungen
    src/pages.js           Seitenrahmen, game_data, Karten- und Minikarten-Endpunkte
    src/screens/           ein Modul pro Bildschirm (Übersicht, Karte, Versammlungsplatz, Stämme, ...)
    src/game/              Spiellogik ohne Web: Gebäude, Einheiten, Kampf, Befehle, Markt, Stämme, Welt
    src/admin.js           Admin-Bereich (/admin)
    views/                 EJS-Vorlagen, public/ die Original-Grafiken, -Skripte und -Stylesheets
    config/                Welt-, Gebäude- und Einheitenwerte sowie Sprachdateien
