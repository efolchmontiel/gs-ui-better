// @ts-nocheck
// Saludo y despedida del Gentleman, como entrada propia en el transcript de Pi.
//
// Por qué appendEntry + registerEntryRenderer y no un widget: los widgets se dibujan arriba
// del editor, o sea después del chat. Una entrada custom queda en el transcript, debajo de
// [Extensions], y no participa del contexto del modelo.
//
// Las caras son PNG inline con el Kitty Graphics Protocol, vía renderImage de pi-tui: la TUI
// ya detecta capacidades y conoce la geometría real de la celda, así que no hace falta
// escribir secuencias de escape a mano. Sin soporte gráfico cae a texto con emojis.
//
// Formato del aviso (banda de personajes arriba, texto rosa debajo):
//   [PNG izquierda] [PNG derecha]
//   ABUELAAAAA · <frase>
// El bloque completo se centra en el ancho disponible del componente y se recalcula en cada
// render, así que un cambio de tamaño de la terminal (SUPER+F, split, fullscreen) reacomoda
// el aviso sin crear otra entrada ni volver a elegir la frase.
// Las frases viven en `frases.json`, al lado de los PNG: ampliar los catálogos no toca este
// archivo.

import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getCapabilities, getPngDimensions, renderImage, visibleWidth } from "@earendil-works/pi-tui";

const TIPO_ENTRADA = "gentleman-greeting";

/** Herramientas que cierran la sesión. Si querés la despedida en otra, agregá su nombre. */
const HERRAMIENTAS_DE_CIERRE = ["mem_session_finalize"];

/**
 * Motivos de session_start que disparan el saludo. Un fork replica el historial y vuelve a
 * emitir session_start con reason "startup", así que además se dedupe por contenido.
 */
const MOTIVOS_DE_SALUDO = ["startup"];

/** Prefijo fijo de todos los mensajes. No se toca: es la gracia. */
const PREFIJO = "ABUELAAAAA";

const ROSA = "\u001b[38;2;255;59;167m";
const RESET = "\u001b[0m";

const DIR_ASSETS = join(homedir(), ".gentle-shell", "agent", "assets", "gentleman-greeting");
const ARCHIVO_FRASES = join(DIR_ASSETS, "frases.json");
const ARCHIVO_ESTADO = join(DIR_ASSETS, "estado-frases.json");

/**
 * Cada momento usa su propio par de imágenes, recortadas al contenido.
 * El caballerito (GENTLEMAN) va a la izquierda porque es quien grita ABUELAAAAA; la abuelita
 * va a la derecha porque es quien escucha la frase.
 */
const IMAGENES = {
  inicio: { izquierda: "inicio-caballerito.png", derecha: "inicio-abuelita.png" },
  cierre: { izquierda: "cierre-caballerito.png", derecha: "cierre-abuelita.png" },
};

const EMOJI = { izquierda: "🎩", derecha: "👵" };

/**
 * Cómo se arma cada aviso. Los dos usan la banda de 3 filas sobre el texto: es la única que se
 * verificó sin artefactos, porque las dos imágenes van con C=1 y no mueven el cursor. La versión
 * de una fila con `moveCursor` dibujaba un fragmento suelto sobre el personaje de la izquierda.
 */
const LAYOUT = {
  inicio: { filas: 3, banda: true },
  cierre: { filas: 3, banda: true },
};

// --- catálogos ------------------------------------------------------------------------
// Los catálogos son datos, no lógica: viven en frases.json. Estas dos entradas sólo existen
// para que el aviso nunca quede vacío si el archivo falta o está roto.

const CATALOGO_MINIMO = {
  inicio: [`${PREFIJO} · ¡salió código del GENTLEMAN!`],
  cierre: [`${PREFIJO} · ¡el GENTLEMAN se retira con elegancia!`],
};

/**
 * Garantiza que la frase arranque con el prefijo. Una frase nueva puede escribirse sin él:
 * acá se le repone, así el requisito no depende de la memoria de quien la agregue.
 */
function normalizarFrase(frase) {
  const limpia = String(frase ?? "").trim();
  if (!limpia) {
    return "";
  }
  if (limpia.startsWith(PREFIJO)) {
    return limpia;
  }
  return `${PREFIJO} · ${limpia.replace(/^[·:\-–—]\s*/, "")}`;
}

let catalogos = null;

function cargarCatalogos() {
  if (catalogos) {
    return catalogos;
  }
  try {
    const datos = JSON.parse(readFileSync(ARCHIVO_FRASES, "utf8"));
    const inicio = (Array.isArray(datos.inicio) ? datos.inicio : []).map(normalizarFrase).filter(Boolean);
    const cierre = (Array.isArray(datos.cierre) ? datos.cierre : []).map(normalizarFrase).filter(Boolean);
    catalogos = {
      inicio: inicio.length ? inicio : CATALOGO_MINIMO.inicio,
      cierre: cierre.length ? cierre : CATALOGO_MINIMO.cierre,
    };
  } catch {
    catalogos = CATALOGO_MINIMO;
  }
  return catalogos;
}

// --- selección ------------------------------------------------------------------------
// Elegir al iniciar y al cerrar, nunca en render(). El estado vive en un JSON chico para
// poder evitar la repetición inmediata entre sesiones distintas.

function leerEstado() {
  try {
    return JSON.parse(readFileSync(ARCHIVO_ESTADO, "utf8"));
  } catch {
    return {};
  }
}

function elegirFrase(clave, catalogo) {
  const estado = leerEstado();
  const anterior = estado[clave];
  const opciones = catalogo.map((_, i) => i).filter((i) => i !== anterior);
  const indice =
    opciones.length > 0
      ? opciones[Math.floor(Math.random() * opciones.length)]
      : (anterior ?? 0);
  estado[clave] = indice;
  try {
    writeFileSync(ARCHIVO_ESTADO, JSON.stringify(estado));
  } catch {
    // Si no se puede escribir el estado, la frase ya elegida sigue siendo válida.
  }
  return catalogo[indice];
}

// --- imágenes y render ---------------------------------------------------------------

// El PNG se lee una vez por proceso; null queda cacheado para no reintentar en cada render.
const cachePng = new Map();

function pngBase64(archivo) {
  if (cachePng.has(archivo)) {
    return cachePng.get(archivo);
  }
  let base64 = null;
  try {
    base64 = readFileSync(join(DIR_ASSETS, archivo)).toString("base64");
  } catch {
    base64 = null;
  }
  cachePng.set(archivo, base64);
  return base64;
}

/**
 * Componente del aviso. Pi le pasa el ancho disponible en cada render y lo vuelve a llamar
 * cuando la terminal cambia de tamaño: por eso el centrado se resuelve acá y no en los datos
 * de la entrada (que se eligen una sola vez, al crearla).
 *
 * Devuelve las cadenas tal cual, sin que la TUI las re-envuelva: el payload base64 del
 * protocolo gráfico no son caracteres visibles y, si la mide como texto, la parte en filas.
 */
class Aviso {
  constructor(momento, texto) {
    this.momento = momento;
    this.texto = texto;
  }
  render(width) {
    return lineasDelAviso(this.momento, this.texto, width);
  }
  invalidate() {
    cacheLinea.clear();
  }
}

/**
 * Recorta la frase por grafemas para que nunca desborde el ancho disponible, conservando
 * siempre el prefijo. Es display-only: la frase guardada en la entrada no se toca, así que
 * cambiar el ancho de la ventana no cambia la frase elegida.
 */
function abreviar(texto, ancho) {
  const limpio = String(texto ?? "");
  const limite = Math.max(1, ancho - 1); // una columna de margen a la derecha
  if (visibleWidth(limpio) <= limite) {
    return limpio;
  }
  const elipsis = "\u2026";
  const prefijo = limpio.startsWith(PREFIJO) ? PREFIJO : "";
  const resto = prefijo ? limpio.slice(prefijo.length) : limpio;
  if (visibleWidth(prefijo + elipsis) > limite) {
    // Ni el prefijo entra completo: se recorta el prefijo mismo.
    return recortarA(prefijo || limpio, limite);
  }
  let acumulado = "";
  for (const parte of Array.from(resto)) {
    if (visibleWidth(prefijo + acumulado + parte + elipsis) > limite) {
      break;
    }
    acumulado += parte;
  }
  const abreviada = `${prefijo}${acumulado.trimEnd()}${elipsis}`;
  return visibleWidth(abreviada) <= limite ? abreviada : recortarA(prefijo, limite);
}

/** Recorta por grafemas hasta `limite` columnas visibles. */
function recortarA(texto, limite) {
  let salida = "";
  for (const parte of Array.from(texto)) {
    if (visibleWidth(salida + parte) > limite) {
      break;
    }
    salida += parte;
  }
  return salida;
}


/**
 * Secuencia de una imagen. `cursorLibre` decide quién mueve el cursor: en banda ninguna de las
 * dos (la separación se hace con espacios), y en línea la de la izquierda sí, para que el texto
 * arranque después de ella.
 *
 * IMPORTANTE: sin `imageId` a propósito. Con `imageId` pi-tui registra el id y en cada cambio de
 * tamaño emite `a=d,d=I,i=<id>` antes de re-emitir; en Herdr esa re-transmisión del id recién
 * borrado no vuelve a pintar nada, y el personaje desaparece. Sin id no hay borrado: la
 * limpieza la hace el `2J` del full render y la imagen se re-emite limpia.
 */
function secuencia(archivo, filas, cursorLibre) {
  const base64 = getCapabilities().images ? pngBase64(archivo) : null;
  if (!base64) {
    return null;
  }
  const dimensiones = getPngDimensions(base64);
  if (!dimensiones) {
    return null;
  }
  // La altura en filas la resuelve la TUI con la geometría real de la celda.
  return renderImage(base64, dimensiones, {
    maxWidthCells: 10,
    maxHeightCells: filas,
    moveCursor: cursorLibre,
  });
}

// Las líneas armadas se cachean por ancho: render() se llama muchas veces y no debe
// re-codificar el PNG en cada pasada.
const cacheLinea = new Map();
const CACHE_MAXIMA = 32;

function lineasDelAviso(momento, texto, anchoDisponible) {
  const ancho = Math.max(1, Math.floor(Number(anchoDisponible) || 80));
  const par = IMAGENES[momento] ?? IMAGENES.inicio;
  const hayGraficos = getCapabilities().images !== null;
  const clave = `${momento}|${texto}|${ancho}|${hayGraficos}`;
  if (cacheLinea.has(clave)) {
    return cacheLinea.get(clave);
  }

  // Camino sin gráficos (o con los PNG caídos): una sola línea, texto con emojis alrededor.
  // El margen de los emojis entra en el centrado y, en anchos extremos, se descarta antes que
  // el prefijo: ABUELAAAAA no se negocia, y una línea más ancha que la terminal aborta el render.
  const lineaDeEmojis = () => {
    const conEmojis = ancho >= PREFIJO.length + 8;
    const margen = conEmojis ? 6 : 0;
    const queda = abreviar(texto, Math.max(1, ancho - margen));
    const bloque = visibleWidth(queda) + margen;
    const relleno = " ".repeat(Math.max(0, Math.floor((ancho - bloque) / 2)));
    const adorno = conEmojis ? `${EMOJI.izquierda} ` : "";
    const cierre = conEmojis ? ` ${EMOJI.derecha}` : "";
    return `${relleno}${adorno}${ROSA}${queda}${RESET}${cierre}`;
  };

  let lineas;
  if (!hayGraficos) {
    lineas = [lineaDeEmojis()];
  } else {
    const config = LAYOUT[momento] ?? LAYOUT.inicio;
    // En banda las dos imágenes quedan quietas y la separación se hace con espacios; en línea
    // la de la izquierda avanza el cursor para que el texto empiece después de ella.
    const izquierda = secuencia(par.izquierda, config.filas, !config.banda);
    const derecha = secuencia(par.derecha, config.filas, false);
    if (!izquierda || !derecha) {
      lineas = [lineaDeEmojis()];
      cacheLinea.set(clave, lineas);
      return lineas;
    }
    const mostrado = abreviar(texto, ancho);
    const anchoTexto = visibleWidth(mostrado);
    // Un único desplazamiento para el bloque completo: la banda y el texto se mueven juntos,
    // así la relación horizontal y vertical entre ellos queda intacta.
    const desplazamiento = " ".repeat(Math.max(0, Math.floor((ancho - anchoTexto) / 2)));
    if (config.banda) {
      // Banda de personajes sobre el texto: se reservan las filas que ocupan las imágenes y
      // el texto va en la última. La banda se mantiene centrada respecto del texto (relación
      // interna sin cambios) y el desplazamiento del bloque la corre junto con el texto.
      const filas = Math.max(izquierda.rows, derecha.rows);
      const anchoBanda = izquierda.columns + 1 + derecha.columns;
      if (ancho < anchoBanda) {
        // Los personajes no entran en este ancho: mejor el fallback de texto que una banda
        // recortada por el borde de la terminal.
        lineas = [lineaDeEmojis()];
        cacheLinea.set(clave, lineas);
        return lineas;
      }
      const relleno = " ".repeat(Math.max(0, Math.floor((anchoTexto - anchoBanda) / 2)));
      const separacion = " ".repeat(izquierda.columns + 1);
      lineas = [
        `${desplazamiento}${relleno}${izquierda.sequence}${separacion}${derecha.sequence}`,
        ...Array(Math.max(0, filas - 1)).fill(""),
        `${desplazamiento}${ROSA}${mostrado}${RESET}`,
      ];
    } else {
      // Una sola línea: personaje, texto, personaje.
      lineas = [`${desplazamiento}${izquierda.sequence} ${ROSA}${mostrado}${RESET} ${derecha.sequence}`];
    }
  }

  if (cacheLinea.size >= CACHE_MAXIMA) {
    const primera = cacheLinea.keys().next().value;
    if (primera !== undefined) {
      cacheLinea.delete(primera);
    }
  }
  cacheLinea.set(clave, lineas);
  return lineas;
}

export default function (pi) {
  let yaSeDespidio = false;

  /** Cierre de la entrada de despedida. Un único lugar para el comando y los eventos. */
  const mostrarDespedida = () =>
    pi.appendEntry(TIPO_ENTRADA, {
      momento: "cierre",
      texto: elegirFrase("cierre", cargarCatalogos().cierre),
    });

  pi.registerEntryRenderer(TIPO_ENTRADA, (entry) => {
    const datos = entry.data ?? {};
    // Las entradas viejas guardaban `cara` en vez de `momento`.
    const momento = datos.momento ?? (datos.cara === "abuela" ? "cierre" : "inicio");
    // Sin caja: el componente mide el ancho que le pasa la TUI en cada render y centra el bloque.
    return new Aviso(momento, datos.texto ?? "");
  });

  pi.on("session_start", (event, ctx) => {
    if (!MOTIVOS_DE_SALUDO.includes(event.reason)) {
      return;
    }
    // Un fork replica el historial y vuelve a emitir session_start: sin este chequeo el
    // saludo queda dos veces en el transcript.
    const yaSaludado = ctx.sessionManager
      .getEntries()
      .some((entrada) => entrada?.customType === TIPO_ENTRADA || entrada?.type === TIPO_ENTRADA);
    if (yaSaludado) {
      return;
    }
    pi.appendEntry(TIPO_ENTRADA, {
      momento: "inicio",
      texto: elegirFrase("inicio", cargarCatalogos().inicio),
    });
  });

  pi.on("tool_result", (event) => {
    if (yaSeDespidio || event.isError) {
      return;
    }
    if (!HERRAMIENTAS_DE_CIERRE.includes(event.toolName)) {
      return;
    }
    yaSeDespidio = true;
    mostrarDespedida();
  });

  /**
   * Comando manual: muestra la despedida sin cerrar Pi y sin consumir tokens. Mostrarla **no**
   * finaliza la sesión de Engram ni implica que se haya guardado nada: sólo pinta el mensaje.
   */
  pi.registerCommand("goodbye", {
    description: "Muestra la despedida (no finaliza Engram ni cierra Pi)",
    handler: async () => {
      mostrarDespedida();
    },
  });

  // La despedida se dispara únicamente con el resultado exitoso de mem_session_finalize. No se
  // cuelga de frases del usuario (diría que Engram terminó cuando quizá no) ni de
  // session_shutdown (probado: llega con la interfaz en teardown y no se pinta).

  // Nota: NO se cuelga la despedida de session_shutdown. Se probó: la entrada se escribe en la
  // sesión al salir de Pi, pero el frame de salida no la pinta porque el evento llega con la
  // interfaz ya en teardown. Queda documentado en vez de dejar un mecanismo que no se ve.
}
