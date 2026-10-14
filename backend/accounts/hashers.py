"""Verifies passwords saved by V5.7.x (Node `scryptSync(password, saltHex, 64)`, stored as scrypt:<salt>:<hex>).

Imported hashes are stored as `node_scrypt$<salt>$<hex>`. Django verifies them and, on the next successful sign-in,
re-hashes the password with its default algorithm, so nobody has to choose a new password.
"""
import hashlib
import hmac

from django.contrib.auth.hashers import BasePasswordHasher, mask_hash

N, R, P, DKLEN = 16384, 8, 1, 64  # Node.js scryptSync defaults used by V5.7.x


def _derive(password, salt):
    # Node passes the salt's hex *text* as the salt, so its UTF-8 bytes are used here as well.
    return hashlib.scrypt(password.encode('utf-8'), salt=salt.encode('utf-8'), n=N, r=R, p=P, dklen=DKLEN,
                          maxmem=64 * 1024 * 1024).hex()


class NodeScryptPasswordHasher(BasePasswordHasher):
    algorithm = 'node_scrypt'

    def encode(self, password, salt):
        self._check_encode_args(password, salt)
        return f'{self.algorithm}${salt}${_derive(password, salt)}'

    def decode(self, encoded):
        algorithm, salt, digest = encoded.split('$', 2)
        assert algorithm == self.algorithm
        return {'algorithm': algorithm, 'salt': salt, 'hash': digest}

    def verify(self, password, encoded):
        decoded = self.decode(encoded)
        return hmac.compare_digest(_derive(password, decoded['salt']), decoded['hash'])

    def safe_summary(self, encoded):
        decoded = self.decode(encoded)
        return {'algorithm': decoded['algorithm'], 'salt': mask_hash(decoded['salt']), 'hash': mask_hash(decoded['hash'])}

    def must_update(self, encoded):
        return True

    def harden_runtime(self, password, encoded):
        pass


def from_v57(encoded):
    """Convert a V5.7.x `scrypt:<salt>:<hex>` value to the stored Django form."""
    prefix, salt, digest = encoded.split(':')
    if prefix != 'scrypt' or len(digest) != DKLEN * 2:
        raise ValueError('Not a V5.7.x scrypt password hash.')
    return f'{NodeScryptPasswordHasher.algorithm}${salt}${digest}'
