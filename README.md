# Control de Procesos - Dashboard CHEFMAN

Dashboard web responsive para monitorear planeaciones y sincronizar información:

**Servidor A (SCEIM) -> Servidor B (CONTROL_PROCESOS) -> Dashboard**

## 1. Requisitos

- Node.js 18+ recomendado.
- Acceso de red desde la máquina donde corre Node.js hacia:
  - Servidor A / SQL Server origen.
  - Servidor B / SQL Server destino.
- Un usuario SQL de lectura para el origen.
- Un usuario SQL con permisos de lectura/escritura para la base destino.

## 2. Crear tabla en servidor B

Ejecuta:

`sql/01_create_database.sql`

en el servidor B.

La tabla `dbo.PLANEACIONES` guarda los datos provenientes de A y, adicionalmente, los estados manuales:

- PREPARADO: Pendiente / En proceso / Completo
- VALIDADO: Pendiente / En proceso / Completo

La sincronización **NO modifica PREPARADO ni VALIDADO**.

## 3. Configurar conexión

Copia:

`.env.example`

a:

`.env`

y cambia los valores.

Ejemplo:

```env
SOURCE_DB_SERVER=192.168.1.10
SOURCE_DB_DATABASE=SCEIM
SOURCE_DB_USER=usuario_lectura
SOURCE_DB_PASSWORD=********

TARGET_DB_SERVER=192.168.1.20
TARGET_DB_DATABASE=CONTROL_PROCESOS
TARGET_DB_USER=usuario_dashboard
TARGET_DB_PASSWORD=********

SYNC_FROM_DATE=2026-11-01
PORT=3000
```

## 4. Instalar

Desde la carpeta del proyecto:

```bash
npm install
```

## 5. Ejecutar

```bash
npm start
```

Abrir:

`http://localhost:3000`

## 6. Cómo funciona la actualización diferencial

Cuando se presiona `ACTUALIZAR`:

1. Node consulta el servidor A.
2. Lee las planeaciones de CHEFMAN desde `SYNC_FROM_DATE`.
3. Compara contra `dbo.PLANEACIONES` del servidor B.
4. Inserta las nuevas.
5. Actualiza solamente los campos provenientes de A cuando cambiaron.
6. Elimina del B las planeaciones que ya no existen en A dentro del rango sincronizado.
7. Conserva intactos `PREPARADO` y `VALIDADO`.
8. El dashboard vuelve a cargar la información de B.

No se hace un borrado/reinserción completo, por lo que los estados manuales no se pierden.

## 7. Nota importante sobre PLANEACION

La implementación considera `VO.ORDERID` / `PLANEACION` como identificador único.

La consulta proporcionada agrupa por `ORDERID`, pero también por `VO.STATUS`, `EDITDATE`, etc. Si en la práctica puede devolver más de una fila para el mismo `ORDERID`, hay que definir una llave compuesta o modificar la consulta antes de ponerlo en producción.

El servidor Node detecta este caso y detiene la sincronización en lugar de sobrescribir datos.

## 8. Arquitectura

```text
             SERVIDOR A
                SCEIM
                 │
                 │ SELECT
                 ▼
        ┌───────────────────┐
        │  Node.js / API    │
        │  Sync diferencial  │
        └─────────┬─────────┘
                  │ INSERT
                  │ UPDATE
                  │ DELETE
                  ▼
             SERVIDOR B
        CONTROL_PROCESOS
                  │
                  │ SELECT
                  ▼
             DASHBOARD
             responsive
```

## 9. Producción

Para uso permanente en una PC/servidor Windows se recomienda ejecutar Node como servicio de Windows (por ejemplo NSSM o un administrador de servicios) y poner el dashboard detrás de IIS o mantenerlo accesible solamente dentro de la red.

No guardar contraseñas dentro de `server.js` ni dentro de `public/`.
