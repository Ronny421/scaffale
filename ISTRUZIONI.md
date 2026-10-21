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

## Libri appena usciti

Gli archivi online aggiungono i libri nuovi qualche giorno o settimana dopo
l'uscita. Se un ISBN non viene trovato, salvalo pure anche solo con il codice:
Scaffale riprova da sola una volta al giorno, all'apertura, e riempie i campi
vuoti appena il libro compare (senza toccare quelli scritti da te). Per avere
subito titolo e autore, nel modulo tocca «Copertina» e fotografala.

## Copia digitale di un libro (PDF o EPUB)

Nella scheda di ogni libro, sezione «Copia digitale», puoi allegare il PDF o l'EPUB.
Il file viene copiato nel database interno dell'app e resta solo sul telefono:
non viene mai caricato online, nemmeno su GitHub. «Apri con…» lo passa alla tua app
di lettura; «Salva nei Download» ne salva una copia. La copia di sicurezza non
include i file, che possono essere molto grandi: conserva gli originali.

## Lettore integrato

Se a un libro hai allegato il PDF o l'EPUB, nella scheda c'è «Leggi». Il lettore
riparte dal punto in cui avevi lasciato e aggiorna da solo il segnalibro.
In alto a destra scegli come scorrere il libro, e la scelta viene ricordata:
- pagine affiancate: trascini in orizzontale e la pagina segue il dito, poi si
  ferma sulla successiva;
- scorrimento verticale: il libro scorre in continuo dall'alto in basso; per gli
  EPUB tutti i capitoli sono uno di seguito all'altro.
Tocca a destra per andare avanti, a sinistra per tornare indietro, al centro per
nascondere i comandi; dal computer puoi usare le frecce della tastiera. «A−/A+» cambiano la dimensione del testo degli EPUB,
«−/+» ingrandiscono i PDF. Funziona anche senza internet.

Se il file ha un numero di pagine diverso dall'edizione cartacea, il segnalibro
viene convertito in proporzione. Per un EPUB senza pagine note, Scaffale le stima
dalla lunghezza del testo; puoi correggerle dalla scheda del libro.

## Sincronizzazione con Google Drive

In Impostazioni → «Sincronizzazione con Google Drive» colleghi Scaffale al tuo Drive.
La preparazione si fa una volta sola dalla console di Google (la guida passo passo è
nell'app): abiliti l'API di Google Drive, configuri la schermata di consenso con te
come «utente di test» e crei un «ID client OAuth» di tipo «Applicazione web» con
origine `https://ronny421.github.io`. Poi incolli l'ID client nell'app e premi
«Accedi con Google» su ogni dispositivo.

- Elenco, segnalibri e copertine si sincronizzano da soli, in una cartella nascosta
  del tuo Drive riservata a Scaffale.
- I PDF e gli EPUB li gestisci tu, dalla scheda del libro, come su OneDrive:
  «Carica su Drive», «Scarica sul telefono», «Libera spazio sul telefono»,
  «Elimina da Drive». I file caricati stanno nella cartella «Scaffale» del tuo Drive.
- Se modifichi lo stesso libro su due dispositivi, vince la modifica più recente;
  il segnalibro si unisce a parte, quindi correggere un titolo sul computer non
  cancella la pagina letta sul telefono.
- Il permesso di Google dura circa un'ora. Finché è valido la sincronizzazione è
  automatica; quando scade, in alto compare «Tocca per sincronizzare»: un tocco lo
  rinnova.
- Scaffale può vedere solo i file che ha creato lei, non il resto del tuo Drive.

## Usarla dal computer

Apri lo stesso indirizzo con Chrome o Edge: puoi anche installarla dall'icona
nella barra degli indirizzi. Con la sincronizzazione con Google Drive ritrovi la
stessa libreria; senza, quella del computer è separata (puoi copiarla con
«Salva copia» sul telefono e «Ripristina copia» sul computer). Su molti computer Chrome non legge i codici a barre: scrivi
l'ISBN a mano.

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
