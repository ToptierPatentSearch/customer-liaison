export const ADMIN_FACTOR_NAME = 'Customer liaison administrator'

function requireData({ data, error }) {
  if (error) throw error
  if (!data) throw new Error('Authenticator information could not be loaded. Please retry.')
  return data
}

export async function loadAdminFactors(mfa) {
  const data = requireData(await mfa.listFactors())
  return {
    verified: (data.all ?? []).filter((factor) => factor.status === 'verified' && factor.factor_type === 'totp'),
    unsupported: (data.all ?? []).some((factor) => factor.status === 'verified' && factor.factor_type !== 'totp'),
    pending: (data.all ?? []).filter((factor) => factor.status === 'unverified' && factor.factor_type === 'totp' && factor.friendly_name === ADMIN_FACTOR_NAME),
  }
}

export async function startAdminEnrollment(mfa) {
  // Recheck on the explicit setup action; never create a replacement for a verified factor.
  const factors = await loadAdminFactors(mfa)
  if (factors.verified.length || factors.unsupported) {
    throw new Error('An authenticator is already registered. Reload this screen and verify with your existing factor.')
  }
  for (const factor of factors.pending) {
    const { error } = await mfa.unenroll({ factorId: factor.id })
    if (error) throw error
  }
  return requireData(await mfa.enroll({ factorType: 'totp', friendlyName: ADMIN_FACTOR_NAME }))
}

export async function verifyAdminFactor(mfa, factorId, code) {
  if (!factorId || !/^\d{6}$/.test(code)) throw new Error('Enter the six-digit code from your authenticator app.')
  requireData(await mfa.challengeAndVerify({ factorId, code }))
  const assurance = requireData(await mfa.getAuthenticatorAssuranceLevel())
  if (assurance.currentLevel !== 'aal2') throw new Error('Second-factor verification could not be confirmed. Please retry.')
}

export function authenticatorQrSource(qrCode) {
  if (typeof qrCode !== 'string') return ''
  if (qrCode.startsWith('data:image/svg+xml')) return qrCode
  if (qrCode.trimStart().startsWith('<svg')) return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(qrCode)}`
  return ''
}
