import test from 'node:test';
import assert from 'node:assert/strict';
import { connectionConfig, failureHint } from './config.mjs';

const env = {
  SQLSERVER_HOST: 'sql.example.internal', SQLSERVER_PORT: '1433',
  SQLSERVER_DATABASE: 'TaskManagement_Test', SQLSERVER_USER: 'taskmanagement_app',
  SQLSERVER_PASSWORD: '  synthetic-test-value  ',
};

test('encrypts by default, preserves password whitespace, and uses the requested database', () => {
  const result = connectionConfig(env);
  assert.equal(result.options.encrypt, true);
  assert.equal(result.options.trustServerCertificate, false);
  assert.equal(result.database, 'TaskManagement_Test');
  assert.equal(result.password, env.SQLSERVER_PASSWORD);
});
test('uses a named instance without also sending a TCP port', () => {
  const result = connectionConfig({ ...env, SQLSERVER_PORT: '', SQLSERVER_INSTANCE: 'SQLEXPRESS01' });
  assert.equal(result.options.instanceName, 'SQLEXPRESS01');
  assert.equal('port' in result, false);
  assert.throws(() => connectionConfig({ ...env, SQLSERVER_INSTANCE: 'SQLEXPRESS01' }), /exactly one/);
});
test('blocks missing credentials and accidental system-database targets', () => {
  assert.throws(() => connectionConfig({ ...env, SQLSERVER_PASSWORD: '' }), /SQLSERVER_PASSWORD/);
  for (const database of ['master', 'Model', 'msdb', 'tempdb']) {
    assert.throws(() => connectionConfig({ ...env, SQLSERVER_DATABASE: database }), /system database/);
  }
});
test('rejects invalid endpoint values and ambiguous certificate options', () => {
  for (const port of ['0', '65536', '1433.5', '1433oops']) {
    assert.throws(() => connectionConfig({ ...env, SQLSERVER_PORT: port }), /whole number/);
  }
  assert.throws(() => connectionConfig({ ...env, SQLSERVER_HOST: 'localhost\\SQLEXPRESS01' }), /hostname/);
  assert.throws(() => connectionConfig({ ...env, SQLSERVER_TRUST_SERVER_CERTIFICATE: 'yes' }), /true or false/);
});
test('connection errors do not expose raw error messages or passwords', () => {
  for (const code of ['ELOGIN', 'ESOCKET', 'ETIMEOUT', 'EINSTLOOKUP', 'EREQUEST', env.SQLSERVER_PASSWORD]) {
    const message = failureHint({ code, message: `Password=${env.SQLSERVER_PASSWORD}` });
    assert.ok(!message.includes(env.SQLSERVER_PASSWORD));
    assert.ok(!message.includes('Password='));
  }
});
