param([Parameter(Mandatory=$true)][string]$OutputPath)
$ErrorActionPreference = 'Stop'
# Ephemeral test certificate only; never installed in a user or machine trust store.
$pilotRsa = [System.Security.Cryptography.RSA]::Create(2048)
try {
  $pilotRequest = [System.Security.Cryptography.X509Certificates.CertificateRequest]::new('CN=127.0.0.1', $pilotRsa, [System.Security.Cryptography.HashAlgorithmName]::SHA256, [System.Security.Cryptography.RSASignaturePadding]::Pkcs1)
  $pilotCertificate = $pilotRequest.CreateSelfSigned([DateTimeOffset]::UtcNow.AddMinutes(-1), [DateTimeOffset]::UtcNow.AddHours(1))
  try { [IO.File]::WriteAllBytes($OutputPath, $pilotCertificate.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Pfx)) }
  finally { $pilotCertificate.Dispose() }
} finally { $pilotRsa.Dispose() }
