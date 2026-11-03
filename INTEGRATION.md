# Integración: secop-scraper → secop-captcha

## Arquitectura

```
secop-scraper (Playwright) ──┐
                             │
                      secop_captcha.py
                             │
                  HTTP POST /solve
                  HTTP POST /verify
                  HTTP GET  /health
                             │
                    secop-captcha (Node.js)
                             │
                  ┌──────────┴──────────┐
                  │                     │
           2Captcha API         CapSolver API
          (primary farm)       (fallback)
```

El scraper descarga documentos de SECOP II con Chromium headless (Playwright). Cuando el portal muestra el reCAPTCHA v2, el scraper interrumpe la descarga, resuelve el captcha vía HTTP contra el servicio local, inyecta el token en el DOM y reintentar la descarga.

## Componentes

### 1. secop-captcha (servicio Node.js)

| Archivo | Propósito |
|---|---|
| `src/server-ponytail.js` | Servidor HTTP con endpoints `/solve`, `/verify`, `/health`, `/redirect` |
| `src/solver-ponytail.js` | Lógica de resolución: 2Captcha, CapSolver, Google siteverify, SECOP CaptchaCheck |
| `Dockerfile` | Imagen `node:22-bookworm` con no-root user |

**Variables de entorno:**

| Variable | Descripción | Default |
|---|---|---|
| `RECAPTCHA_SERVICE_KEY` | API key de 2Captcha (primaria) | — |
| `CAPSOLVER_API_KEY` | API key de CapSolver (fallback) | — |
| `FARM_SERVICE` | Granja por defecto: `"2captcha"` o `"capsolver"` | `"2captcha"` |
| `PORT` | Puerto del servidor | `3000` |
| `HOST` | Dirección de bind | `"127.0.0.1"` |
| `SECOP_CAPTCHA_API_KEY` | API key para autenticar endpoints | — |
| `MAX_CONCURRENT` | Máximo de peticiones simultáneas | `10` |
| `VERIFY_WITH_GOOGLE` | `"true"` para activar Google siteverify | `"true"` |
| `PUPPETEER_EXECUTABLE_PATH` | Ruta al binario de Chrome | Auto-detect |

**Endpoints:**

| Método | Ruta | Autenticación | Descripción |
|---|---|---|---|
| `GET` | `/health` | No | Estado del servicio |
| `POST` | `/solve` | `X-API-Key` | Resuelve reCAPTCHA |
| `POST` | `/verify` | `X-API-Key` | Verifica un token |
| `GET` | `/redirect` | No | Info de redirección y captcha |

### 2. secop_captcha.py (cliente Python)

| Archivo | Propósito |
|---|---|
| `secop_captcha.py` | Cliente que llama al servicio vía HTTP |

**Funciones:**

| Función | Parámetros | Retorno | Descripción |
|---|---|---|---|
| `solve_captcha(url, timeout_s=120)` | `url` (página con captcha), `timeout_s` (máx. espera) | `str \| None` | POST `/solve` con reintentos automáticos |
| `verify_captcha(token)` | `token` | `dict` | POST `/verify` para validar un token |
| `check_health()` | — | `bool` | GET `/health` para verificar disponibilidad |
| `captcha_service_url()` | — | `str` | URL base del servicio |
| `captcha_method()` | — | `str` | Método de resolución |
| `captcha_api_key()` | — | `str \| None` | API key del servicio |

**Variables de entorno:**

| Variable | Descripción | Default |
|---|---|---|
| `SECOP_CAPTCHA_URL` | URL del servicio de captcha | `http://localhost:3000` |
| `SECOP_CAPTCHA_METHOD` | Método: `"service"`, `"capsolver"`, `"puppeteer"` | `"service"` |
| `SECOP_CAPTCHA_KEY` | API key para autenticación del servicio | — |

### 3. secop-scraper (scraper principal)

| Archivo | Propósito |
|---|---|
| `secop.py` | Scraper principal que importa `solve_captcha` |
| `.env` | Configuración con `SECOP_CAPTCHA_URL` habilitado |

## Flujo de ejecución

```
1. download_one(page, doc) intenta browser_download(page, url)
                          │
                          ▼
                    ¿Página de captcha? ──NO──→ Descarga normal
                          │
                         SÍ (lanza Captcha)
                          │
                          ▼
2. _captcha_enabled() → ¿SECOP_CAPTCHA_URL en os.environ?
                          │
                         NO → raise Captcha (comportamiento original)
                          │
                         SÍ
                          │
                          ▼
3. solve_captcha(solve_url)
   ├── requests.post("/solve", json={"method": "service", "url": url, "fallback": True})
   ├── Reintentos hasta timeout (120s default), sleep 2s entre intentos
   └── Devuelve token o None
                          │
                          ▼
4. _inject_token(page, token)
   ├── Inyecta token en g-recaptcha-response y txaresponseKey del DOM
   ├── Si estamos en GoogleReCaptcha page: navega a CaptchaCheck
   └── Valida token con SECOP (/Public/Common/GoogleReCaptcha/CaptchaCheck)
                          │
                          ▼
5. Reintentar browser_download con el token inyectado
   ├── Éxito → descarga el documento
   └── Falla → retry (máx. 3 rondas)
```

## Integración con Docker Compose

El `docker-compose` de `secop-scraper` orquesta ambos servicios en un solo comando:

```yaml
services:
  secop:              # El scraper
    depends_on:
      - captcha-svc
    environment:
      SECOP_CAPTCHA_URL: ${SECOP_CAPTCHA_URL:-http://captcha-svc:3000}

  captcha-svc:        # El servicio de captcha
    build: ../secop-captcha
    environment:
      PORT: 3000
      RECAPTCHA_SERVICE_KEY: ${RECAPTCHA_SERVICE_KEY:-}
      CAPSOLVER_API_KEY: ${CAPSOLVER_API_KEY:-}
      FARM_SERVICE: ${FARM_SERVICE:-2captcha}
    ports:
      - "3000:3000"
```

### Arranque

```bash
cd /Users/ed/Projects/secop-scraper

# 1. Copiar .env y agregar las variables de captcha
cp .env.example .env
# Editar .env y agregar:
#   RECAPTCHA_SERVICE_KEY=tu_key_aqui
#   CAPSOLVER_API_KEY=tu_key_aqui
#   SECOP_CAPTCHA_KEY=test-api-key

# 2. Iniciar ambos servicios
docker compose up -d

# 3. Verificar que el servicio de captcha está vivo
docker compose exec captcha-svc curl -s http://localhost:3000/health

# 4. Verificar que el scraper puede conectar
docker compose run --rm secop python3 -c "
from secop_captcha import check_health
print('Captcha service:', 'ONLINE' if check_health() else 'OFFLINE')
"

# 5. Logs en tiempo real
docker compose logs -f

# 6. Parar
docker compose down
```

## Integración local (sin Docker)

### Paso 1: Iniciar el servicio de captcha

```bash
cd /Users/ed/Projects/secop-captcha
cp .env.example .env
# Editar .env con las API keys reales

# Verificar configuración
node -e "
const env = require('dotenv').config();
console.log('RECAPTCHA_SERVICE_KEY:', process.env.RECAPTCHA_SERVICE_KEY ? '✓' : '✗');
console.log('CAPSOLVER_API_KEY:', process.env.CAPSOLVER_API_KEY ? '✓' : '✗');
"

# Iniciar el servidor
npm start
```

### Paso 2: Verificar que el servicio responde

```bash
# Health check
curl http://127.0.0.1:3000/health

# Probar resolución
curl -X POST http://127.0.0.1:3000/solve \
  -H "Content-Type: application/json" \
  -H "X-API-Key: test-api-key" \
  -d '{"method":"service"}'
```

### Paso 3: Configurar el scraper

```bash
cd /Users/ed/Projects/secop-scraper

# Verificar que .env tiene las variables de captcha
cat .env | grep SECOP_CAPTCHA
# Debe mostrar:
#   SECOP_CAPTCHA_URL=http://localhost:3000
#   SECOP_CAPTCHA_METHOD=service
#   SECOP_CAPTCHA_KEY=test-api-key

# Verificar que el scraper detecta el servicio
python3 -c "
import os
exec(open('.env').read().split('#')[0])
from secop_captcha import check_health
print('Captcha service:', 'ONLINE' if check_health() else 'OFFLINE')
"
```

### Paso 4: Ejecutar el scraper

```bash
# Descargar procesos
python3 secop.py data --palabras "libro, material didáctico"

# Descargar documentos (si aparece captcha, lo resuelve automáticamente)
python3 secop.py docs --limit 20

# Verificar estado
python3 secop.py status
```

## Comportamiento del cliente Python

El cliente `secop_captcha.py` tiene un mecanismo de reintentos robusto:

1. **Timeout total:** hasta 120 segundos (configurable)
2. **Reintentos en error 500:** sleep 2s, reintentar
3. **Reintentos en error 429 (rate limit):** sleep 2s, reintentar
4. **Reintentos en error JSON:** sleep 2s, reintentar
5. **Token vacío:** sleep 3s, reintentar
6. **Excepción de red:** sleep 2s, reintentar
7. **Devuelve `None`** si se agota el timeout

## Validaciones del servicio

### Input validation

| Campo | Método | Validación |
|---|---|---|
| `url` | `/solve` (method=puppeteer) | Debe ser URL válida y hostname en allowlist |
| `url` | `/solve` (method=puppeteer) | Hostname debe estar en: `community.secop.gov.co`, `localhost`, `127.0.0.1` |
| `token` | `/verify` | String con longitud ≥ 50 |
| `method` | `/solve` | Debe ser: `"service"`, `"puppeteer"`, `"local"` |

### Middlewares

| Middleware | Comportamiento |
|---|---|
| **Auth** | Requiere `X-API-Key` header para todos los endpoints excepto `/health` y `OPTIONS` |
| **Rate Limit** | 60 requests/minute por IP |
| **Concurrency** | Máximo `MAX_CONCURRENT` (default 10) requests simultáneos, responde 429 si se supera |
| **CORS** | `Access-Control-Allow-Origin: *` en todas las respuestas |
| **Cache-Control** | `no-store` en todas las respuestas JSON |

## Troubleshooting

### Scraper no puede conectar al servicio

```bash
# Verificar que el servicio está corriendo
curl -s http://127.0.0.1:3000/health

# Verificar que no hay conflicto de puerto
lsof -i :3000

# Verificar que el scraper tiene las variables correctas
cat /Users/ed/Projects/secop-scraper/.env | grep SECOP_CAPTCHA
```

### Servicio responde 401 Unauthorized

```bash
# Verificar que las API keys coinciden
# scraper: SECOP_CAPTCHA_KEY en .env
# servicio: SECOP_CAPTCHA_API_KEY en .env
# Deben ser el mismo valor
```

### Servicio responde 429 Too Many Requests

```bash
# Reducir MAX_CONCURRENT en .env del servicio
# MAX_CONCURRENT=5
```

### Servicio responde 400 Bad Request

```bash
# Verificar la estructura del body enviado
curl -v -X POST http://127.0.0.1:3000/solve \
  -H "Content-Type: application/json" \
  -H "X-API-Key: test-api-key" \
  -d '{"method":"service"}'
```

### Token muy corto

```bash
# El scraper envía tokens de 48+ caracteres
# Verificar que el servicio de captcha devuelve tokens válidos
curl -X POST http://127.0.0.1:3000/solve \
  -H "Content-Type: application/json" \
  -H "X-API-Key: test-api-key" \
  -d '{"method":"service"}' | python3 -m json.tool
```

## Logs del servicio

El servicio registra en consola con formato:

```
[TIMESTAMP] IP METHOD PATH → STATUS (DURATIONms)
```

Ejemplo:
```
[2026-11-02T18:45:01.075Z] 127.0.0.1 GET /health → 200 (2ms)
[2026-11-02T18:45:01.118Z] 127.0.0.1 POST /solve → 500 (1582ms)
```

Los errores (≥ 400) van a `stderr` con `console.error()`. Los warnings de auth van a `console.warn()`.

## Dependencias

| Paquete | Versión | Uso |
|---|---|---|
| `dotenv` | ^18.0.9 | Carga variables de entorno desde `.env` |
| `puppeteer` | ^23.0.0 | Browser headless para resolución local |
| `requests` | — | Cliente HTTP del scraper (pip) |
