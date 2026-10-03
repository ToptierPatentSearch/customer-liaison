function requireData({ data, error }, fallbackMessage) {
  if (error) throw error
  if (!data) throw new Error(fallbackMessage)
  return data
}

export async function loadRecoveryMfaRequirement(mfa) {
  const assurance = requireData(
    await mfa.getAuthenticatorAssuranceLevel(),
    'Authenticator assurance information could not be loaded. Please retry.',
  )

  if (assurance.currentLevel === 'aal2') {
    return { required: false, factors: [], unsupported: false }
  }

  const factorData = requireData(
    await mfa.listFactors(),
    'Authenticator information could not be loaded. Please retry.',
  )
  const verified = (factorData.all ?? []).filter((factor) => factor.status === 'verified')
  const factors = verified.filter((factor) => factor.factor_type === 'totp')

  return {
    required: verified.length > 0,
    factors,
    unsupported: verified.some((factor) => factor.factor_type !== 'totp'),
  }
}

export async function verifyRecoveryMfaFactor(mfa, factorId, code) {
  if (!factorId || !/^\d{6}$/.test(code)) {
    throw new Error('Enter the six-digit code from your authenticator app.')
  }

  requireData(
    await mfa.challengeAndVerify({ factorId, code }),
    'Authenticator verification failed. Please retry.',
  )

  const assurance = requireData(
    await mfa.getAuthenticatorAssuranceLevel(),
    'Authenticator assurance information could not be loaded. Please retry.',
  )
  if (assurance.currentLevel !== 'aal2') {
    throw new Error('Second-factor verification could not be confirmed. Please retry.')
  }
}
