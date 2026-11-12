-- EJEMPLO. Ajusta nombres de usuarios según tu Active Directory / SQL Server.
-- El usuario de ORIGEN solamente necesita permisos de lectura sobre SCEIM.
-- El usuario de DESTINO necesita SELECT/INSERT/UPDATE/DELETE sobre CONTROL_PROCESOS.

USE CONTROL_PROCESOS;
GO

-- Ejemplo:
-- CREATE LOGIN dashboard_app WITH PASSWORD = 'CAMBIAR_PASSWORD';
-- CREATE USER dashboard_app FOR LOGIN dashboard_app;
-- ALTER ROLE db_datareader ADD MEMBER dashboard_app;
-- ALTER ROLE db_datawriter ADD MEMBER dashboard_app;
--
-- Para SERVIDOR A:
-- otorgar solamente SELECT a las vistas utilizadas por SOURCE_QUERY.
