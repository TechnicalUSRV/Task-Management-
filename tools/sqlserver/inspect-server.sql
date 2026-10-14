-- Run in SSMS on the intended SQL Server. These queries only read metadata.
SELECT SERVERPROPERTY('ServerName') AS server_name,
       SERVERPROPERTY('InstanceName') AS instance_name,
       SERVERPROPERTY('ProductVersion') AS product_version,
       SERVERPROPERTY('Edition') AS edition,
       SERVERPROPERTY('IsIntegratedSecurityOnly') AS windows_auth_only;

-- The local address/port can be NULL when SSMS connects using shared memory.
SELECT CONNECTIONPROPERTY('net_transport') AS transport,
       CONNECTIONPROPERTY('local_net_address') AS connected_address,
       CONNECTIONPROPERTY('local_tcp_port') AS connected_tcp_port;

-- Change this to the database you created if it has a different name.
SELECT name, state_desc, collation_name
FROM sys.databases
WHERE name = N'TaskManagement_Test';
