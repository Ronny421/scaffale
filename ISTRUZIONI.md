# Scaffale: come installarla sul telefono

Scaffale è una PWA (Progressive Web App): un sito che Chrome per Android può
installare come app vera, con icona nella schermata Home, apertura a schermo
intero e funzionamento offline.

Per installarla basta metterla online una volta, gratis, su GitHub Pages.
Fotocamera e installazione richiedono un indirizzo sicuro (https://),
ed è proprio quello che GitHub Pages fornisce.

## 1. Pubblicala su GitHub Pages (una volta sola, da computer)

1. Crea un account gratuito su https://github.com
2. In alto a destra: "+" → "New repository". Nome: `scaffale`.
   Lascia "Public" e premi "Create repository".
3. Nella pagina del repository vuoto clicca "uploading an existing file".
4. Estrai lo zip sul computer e trascina nella pagina **il contenuto** della
   cartella `scaffale` (index.html, sw.js, le cartelle js, icons, vendor…),
   non la cartella stessa. Premi "Commit changes".
5. Vai in Settings → Pages. Alla voce "Branch" scegli `main` e `/ (root)`,
   poi "Save".
6. Dopo 1-2 minuti l'app è su `https://TUONOME.github.io/scaffale/`

## 2. Installala sul telefono

1. Apri quell'indirizzo con **Chrome** sul telefono Android.
2. Menu ⋮ → "Aggiungi a schermata Home" → "Installa".
3. Compare l'icona colorata di Scaffale. Da qui in poi aprila sempre dall'icona.

## 3. Primo avvio (con internet)

1. Aggiungi un libro e consenti l'accesso alla **fotocamera** quando Chrome lo chiede.
2. Impostazioni (rotella) → "Lettura del testo offline" → "Scarica ora".
   Sono circa 12 MB, meglio col Wi-Fi. Serve per leggere il testo dalle foto
   senza internet.

## Cosa funziona offline e cosa no

| Funzione | Offline |
|---|---|
| Aprire l'app, sfogliare, cercare, raggruppare | Sì |
| Segnalibro, modifica, eliminazione | Sì |
| Scansione del codice a barre | Sì (legge l'ISBN) |
| Lettura testo da foto (OCR) | Sì, dopo il download unico |
| Esporta PDF | Sì |
| Dati automatici da ISBN (titolo, autore, anno, genere, copertina) | No: servono gli archivi online. I libri aggiunti offline vengono completati quando torni online, con il pulsante "Completa ora" |

## Se la ricerca per ISBN non trova i libri

Google Books, senza una chiave, usa un limite giornaliero di richieste
condiviso fra tutti gli utenti del mondo, che si esaurisce spesso. In quel caso
l'app lo dice esplicitamente e prova anche Open Library. Per risolvere del
tutto, crea una chiave personale gratuita (1.000 ricerche al giorno solo per te):
in Impostazioni → «Ricerca dei dati online» trovi i passaggi e il pulsante
«Verifica gli archivi», che mostra lo stato di ogni fonte.

La chiave resta salvata solo sul telefono: non va mai scritta nei file del
repository, che è pubblico.

## Farla installare a un'altra persona

In Impostazioni → «Invita qualcuno» l'app crea un link da mandare (per esempio su
WhatsApp). Se hai salvato una chiave di ricerca, il link la contiene già: chi lo
apre con Chrome trova la ricerca dei libri configurata e un pulsante «Installa».
La chiave sta dopo il simbolo # del link, una parte che il browser non invia mai
al server. Manda il link solo a persone di cui ti fidi.

Ogni telefono ha la sua libreria separata: i libri non si vedono fra telefoni.

## Codici a barre: ISBN ed EAN

Sui libri il codice a barre è un EAN-13. Se inizia con 978 o 979 è l'ISBN stesso
e l'app trova i dati in automatico. Se inizia con 977 è una pubblicazione periodica
(fumetti, libri da edicola): l'app mostra l'ISSN e ti propone di fotografare la
copertina. Gli altri EAN (per esempio le etichette dei negozi) vengono cercati, ma
spesso non compaiono negli archivi: se sul libro c'è un altro codice che inizia con
978 o 979, scansiona quello.

## Permessi

- **Fotocamera**: richiesta alla prima scansione. Se l'hai negata per sbaglio:
  Impostazioni Android → App → Chrome → Autorizzazioni → Fotocamera.
- **Archiviazione**: non serve alcun permesso. I libri stanno nel database
  interno dell'app.

## Attenzione ai dati

I libri sono salvati solo sul telefono. Se cancelli i dati di Chrome o
disinstalli l'app, li perdi. Fai ogni tanto Impostazioni → "Salva copia":
ottieni un file da conservare (Drive, email…) e da reimportare con
"Ripristina copia".

## Aggiornare l'app

Se in futuro modifichi i file, ricaricali su GitHub nello stesso modo.
Il telefono scarica la nuova versione da solo al primo avvio con internet;
diventa visibile dall'avvio successivo. Se cambi file dell'app, aumenta anche
il numero di VERSION in `sw.js`.
