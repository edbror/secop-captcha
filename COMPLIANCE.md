# NOTA DE CUMPLIMIENTO — Solucionador de CAPTCHA SECOP II

**Documento interno** — No distribuir fuera del equipo.  
**Fecha:** 2026-11-02  
**Estado:** Borrador pendiente de confirmación por escrito de Colombia Compra Eficiente

---

## 1. Contexto

El solucionador de reCAPTCHA v2 (`secop-captcha`) se utiliza para resolver los desafíos de verificación que presenta la plataforma SECOP II (portal `community.secop.gov.co`) durante la automatización de descarga de documentos de procesos de contratación pública.

---

## 2. Técnicas Técnicas del Solver

El solver implementa tres categorías de técnicas para evitar ser detectado como automatización (bot):

### 2.1 Ocultación de señal de automatización

Al iniciar el navegador headless (Puppeteer), se redefinen las siguientes propiedades de `navigator` mediante `evaluateOnNewDocument`:

| Propiedad | Valor original (headless) | Valor inyectado | Propósito |
|---|---|---|---|
| `navigator.webdriver` | `true` | `false` | Ocultar la señal que Google y otros servicios usan para detectar navegadores controlados por automatización |
| `window.navigator.chrome.runtime` | `undefined` | `{}` | Simular que el navegador tiene Chrome DevTools Protocol (bypass de detección de Puppeteer) |
| `window.navigator.chrome.loadTimes` | `undefined` | `() => ({})` | Simular API de rendimiento de Chrome |
| `window.navigator.chrome.csi` | `undefined` | `() => ({})` | Simular Client-Server Information API |
| `window.navigator.chrome.app` | `undefined` | `{}` | Simular Chrome App API |
| `Object.getPrototypeOf(navigator.plugins)` | `PluginArray` | `Array` | Alterar la estructura interna de `navigator.plugins` para que no coincida con un navegador estándar |
| `Object.getPrototypeOf(navigator.languages)` | `LanguagePluginArray` | `Array` | Alterar la estructura de `navigator.languages` |

### 2.2 Enmascaramiento de identidad de red

El solver modifica las siguientes cabeceras HTTP y del navegador:

- **User-Agent:** Se fija un User-Agent de Chrome 120 en macOS (ver `USER_AGENT` en `solver-ponytail.js`):
  ```
  Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36
  (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36
  ```
- **Referer:** Se envía `https://community.secop.gov.co/Public/Common/GoogleReCaptcha/Index` como Referer en las solicitudes de resolución.
- **Blink features:** Se desactiva la característica `AutomationControlled` de Chromium:
  ```
  --disable-blink-features=AutomationControlled
  ```

### 2.3 Alteración de propiedades del navegador

Además de las modificaciones JS, la configuración de lanzamiento de Puppeteer incluye:

- `headless: 'new'` — Modo headless moderno (vs legacy, más detectable)
- `defaultViewport: { width: 1280, height: 720 }` — Resolución estándar, no vacía
- `--disable-extensions` — Sin extensiones que puedan revelar automatización
- Sin fingerprint de resolución que difiera de un navegador real

---

## 3. Servicios Externos de Resolución

El solver delega la resolución real de los reCAPTCHAs a dos granjas externas que utilizan **trabajadores humanos** para resolver los desafíos visuales:

| Servicio | Rol | API Key | Endpoints |
|---|---|---|---|
| **2Captcha** | Servicio principal | `RECAPTCHA_SERVICE_KEY` | `2captcha.com/in.php` (submit), `2captcha.com/res.php` (poll) |
| **CapSolver** | Servicio de respaldo | `CAPSOLVER_API_KEY` | `api.capsolver.com/createTask`, `api.capsolver.com/getResult` |

**Flujo:** Se envía el reCAPTCHA a 2Captcha (por defecto). Si falla, se reintentan con CapSolver. Cada tarea es resuelta por un operador humano que ingresa la respuesta.

**Tiempo estimado de resolución:**
- 2Captcha: 5–30 segundos (polling cada 1 segundo, máximo 2 minutos)
- CapSolver: 10–60 segundos (polling cada 3 segundos, máximo 2 minutos)

---

## 4. Implicaciones de Red

### 4.1 Origen del tráfico

Todo el tráfico del solucionador sale de la **Mac de Eduardo** y utiliza su **dirección IP pública** como origen. Esto incluye:

- Tráfico del scraper (`secop-scraper`) hacia `community.secop.gov.co`
- Tráfico del servicio `secop-captcha` hacia las APIs de 2Captcha y CapSolver
- Tráfico de verificación hacia `google.com/recaptcha/api/siteverify`

### 4.2 Tercerización de la resolución

Al enviar los captchas a servicios externos, se está compartiendo con terceros:

- La URL de la página que contiene el captcha (`https://community.secop.gov.co/Public/Common/GoogleReCaptcha/Index`)
- El site key del captcha (`6LcMmakZAAAAAB157Q90hORUGtNd790TCws4vBNw`)
- El token resuelto (que valida frente a Google y SECOP)

### 4.3 Visibilidad

Si SECOP o Colombia Compra Eficiente monitorearan el tráfico de sus IPs o realizaran auditoría de acceso, podrían:

1. Ver múltiples solicitudes de resolución que llegan desde una misma IP
2. Correlacionar los patrones de navegación con comportamiento automatizado
3. Detectar que los tokens provienen de granjas externas (score bajo en Google reCAPTCHA)

---

## 5. Recomendación de SECOP — Confirmación Pendiente

Según la llamada de Eduardo del **30 de octubre de 2026**, un representante de SECOP sugirió **verbalmente** que era aceptable utilizar un servicio de resolución de captchas.

**Esta recomendación es verbal, no existe registro por escrito.** Antes de seguir utilizando el solver en producción, se recomienda:

- [ ] Solicitar por correo electrónico al equipo de Colombia Compra Eficiente una confirmación explícita de que el uso de servicios de resolución de captchas es aceptable
- [ ] Documentar la respuesta en este mismo archivo
- [ ] Si no se obtiene respuesta por escrito, considerar desactivar el solver en producción o evaluar alternativas

---

## 6. Preguntas Abiertas para el Equipo de Negocio

| # | Pregunta | Estado | Responsable |
|---|---|---|---|
| 1 | ¿Santillana ya recibe alertas por correo electrónico de SECOP II? Si sí, ¿desde cuándo y con qué frecuencia? | Pendiente | Equipo de negocio |
| 2 | ¿Cuál es la lista completa de códigos UNSPSC configurados actualmente en el scraper? | Pendiente | Equipo de negocio |
| 3 | ¿Es indispensable descargar el proceso el mismo día que se publica, o hay un margen de tiempo aceptable? | Pendiente | Equipo de negocio |
| 4 | ¿Se ha agendado una sesión de prueba con SECOP / Colombia Compra Eficiente para validar el flujo con ellos? | Pendiente | Equipo de negocio |

---

## 7. Evaluación de Riesgo

### 7.1 ¿Qué pasa si son detectados como bot?

| Escenario | Probabilidad | Impacto | Descripción |
|---|---|---|---|
| **Bloqueo temporal de IP** | Media | Bajo/Medio | SECOP podría bloquear temporalmente la IP de acceso. El scraper fallaría hasta que se cambie la IP o se espere el desbloqueo. |
| **Bloqueo permanente de IP** | Baja/Media | Alto | Si SECOP considera el comportamiento como intento de intrusión o violación de términos de uso, podría bloquear la IP permanentemente. |
| **Acceso revocado a la plataforma** | Baja | Alto | Colombia Compra Eficiente podría revocar el acceso a la cuenta o al dominio completo de scraping. |
| **Implicaciones legales / contractuales** | Baja | Muy alto | Si los términos de uso de SECOP II prohíben explícitamente la automatización (lo cual debe verificarse), podría haber consecuencias contractuales o regulatorias. |
| **Daño reputacional** | Baja | Medio | Si se hace público el uso de herramientas automatizadas para acceder a datos públicos de contratación. |

### 7.2 Riesgos adicionales

| Riesgo | Nivel | Detalle |
|---|---|---|
| **Tercerización de datos** | 🟡 Medio | Se envían URLs y site keys de SECOP a servicios de terceros (2Captcha, CapSolver). Estos servicios almacenan las imágenes de los captchas temporalmente. |
| **Dependencia de servicios externos** | 🟡 Medio | Si 2Captcha o CapSolver caen o cambian sus APIs, el solver se rompe. Hay fallback entre granjas, pero sigue siendo una dependencia externa. |
| **Verificación de Google saltada** | 🟡 Medio | En producción, `VERIFY_WITH_GOOGLE=false` desactiva la verificación del token con Google. Se confía solo en que SECOP acepte el token. Esto puede enmascarar tokens inválidos. |
| **Términos de uso de SECOP II** | 🟠 Alto | **No se ha verificado si los términos de uso de SECOP II permiten o prohíben la automatización.** Esto es un riesgo no mitigado hasta que se revise. |

### 7.3 Resumen de riesgo

| Categoría | Nivel |
|---|---|
| **Riesgo legal / contractual** | 🟠 ALTO — Términos de uso de SECOP no verificados |
| **Riesgo operativo** | 🟡 MEDIO — Depende de servicios externos, posible bloqueo de IP |
| **Riesgo de privacidad** | 🟡 MEDIO — Datos pasan por terceros |
| **Riesgo reputacional** | 🟢 BAJO — Baja probabilidad de exposición pública |

**Riesgo general: 🟡🟠 MEDIO-ALTO**

---

## 8. Próximos Pasos

1. **URGENTE:** Revisar los términos de uso de SECOP II para determinar si la automatización está permitida o prohibida.
2. **URGENTE:** Solicitar por escrito a Colombia Compra Eficiente la confirmación sobre el uso de servicios de resolución de captchas.
3. **ALTA:** Obtener las respuestas a las 4 preguntas del equipo de negocio (sección 6).
4. **MEDIA:** Evaluar si se debe reactivar la verificación con Google (`VERIFY_WITH_GOOGLE=true`) para detectar tokens inválidos.
5. **MEDIA:** Evaluar alternativas a la tercerización (ej. resolución local con modelos de visión por computadora) si la dependencia de terceros se considera inaceptable.
6. **NORMAL:** Documentar cualquier comunicación escrita con SECOP / Colombia Compra Eficiente en este archivo.

---

*Documento elaborado a partir de la revisión del código fuente, la documentación técnica (`README.md`, `INTEGRATION.md`) y la llamada del 30 de octubre de 2026 con Eduardo. Este documento es interno y no constituye asesoría legal.*
