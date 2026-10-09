import test from 'node:test';
import assert from 'node:assert/strict';
import { requireEmail, optionalUsername, requirePassword, publicUser, requireOtp } from '../src/services/account-validation.js';
import { digestOtp, otpMatches, generateOtp } from '../src/services/account-otp.js';

const pepper = 'a-very-long-secret-pepper-for-seefix-tests-only';
test('normalizes emails and rejects fake syntax', () => {
  assert.equal(requireEmail(' User@Example.COM '), 'user@example.com');
  assert.throws(() => requireEmail('not-an-email'));
});
test('usernames are optional, lowercase and restricted to safe characters', () => {
  assert.equal(optionalUsername(' Hello.User '), 'hello.user');
  assert.equal(optionalUsername(undefined), undefined);
  assert.throws(() => optionalUsername('a'));
  assert.throws(() => optionalUsername('invalid@user'));
});
test('password protects bcrypt 72-byte limit', () => {
  assert.equal(requirePassword('correctHorse1'), 'correctHorse1');
  assert.throws(() => requirePassword('short'));
  assert.throws(() => requirePassword('é'.repeat(40)));
});
test('OTP format requires exactly six digits', () => {
  assert.equal(requireOtp('123456'), '123456');
  assert.throws(() => requireOtp('12345'));
  assert.throws(() => requireOtp('anything'));
});
test('OTP digest is bound to user, purpose and email and uses constant-time match', () => {
  const data = { userId: 'user1', purpose: 'EMAIL_CHANGE', email: 'user@example.com', otp: '123456', pepper };
  const hash = digestOtp(data);
  assert.equal(hash.length, 64);
  assert.equal(otpMatches(hash, hash), true);
  assert.equal(otpMatches(hash, digestOtp({ ...data, purpose:'PASSWORD_RESET' })), false);
  assert.equal(otpMatches(hash, digestOtp({ ...data, email:'other@example.com' })), false);
  assert.equal(otpMatches('not-a-hash', hash), false);
});
test('OTP generator produces six-digit codes', () => {
  for (let i=0;i<25;i++) assert.match(generateOtp(), /^[1-9]\d{5}$/);
});
test('public user mapping never exposes password hashes or credentials version', () => {
  const result = publicUser({ Id: 'id', Email: 'x@y.com', FullName: 'Reporter', Role:'REPORTER',
    EmailVerifiedAt: null, EmailVerificationRequired: true, PasswordHash: 'do-not-show', CredentialsVersion: 10 });
  assert.equal(result.emailVerified, false);
  assert.equal(result.emailVerificationRequired, true);
  assert.equal(result.PasswordHash, undefined);
  assert.equal(result.CredentialsVersion, undefined);
});
