const grokHelper = require('../src/utils/grokHelper')

describe('grokHelper upstream modes', () => {
  const originalEnv = { ...process.env }

  afterEach(() => {
    process.env = { ...originalEnv }
    delete process.env.XAI_ALLOW_UNSAFE_URL_OVERRIDES
    delete process.env.XAI_GROK_CLI_VERSION
    delete process.env.XAI_OAUTH_AUTHORIZE_URL
    delete process.env.XAI_OAUTH_TOKEN_URL
    delete process.env.XAI_BASE_URL
  })

  describe('OAuth default upstream', () => {
    it('sends OAuth accounts to the CLI chat proxy by default', () => {
      expect(
        grokHelper.resolveAccountBaseUrl({
          authType: grokHelper.AUTH_TYPES.OAUTH
        })
      ).toBe(grokHelper.DEFAULT_CLI_BASE_URL)
    })

    it('redirects legacy OAuth accounts that stored api.x.ai to the CLI proxy', () => {
      expect(
        grokHelper.resolveAccountBaseUrl({
          authType: grokHelper.AUTH_TYPES.OAUTH,
          baseUrl: 'https://api.x.ai/v1'
        })
      ).toBe(grokHelper.DEFAULT_CLI_BASE_URL)
    })

    it('keeps the CLI proxy host and redirects regional API hosts to the CLI proxy', () => {
      expect(
        grokHelper.resolveAccountBaseUrl({
          authType: grokHelper.AUTH_TYPES.OAUTH,
          baseUrl: 'https://cli-chat-proxy.grok.com/v1'
        })
      ).toBe(grokHelper.DEFAULT_CLI_BASE_URL)

      expect(
        grokHelper.resolveAccountBaseUrl({
          authType: grokHelper.AUTH_TYPES.OAUTH,
          baseUrl: 'https://us-west-2.api.x.ai/v1'
        })
      ).toBe(grokHelper.DEFAULT_CLI_BASE_URL)
    })

    it('ignores a third-party OAuth upstream unless customUpstream is enabled', () => {
      expect(
        grokHelper.resolveAccountBaseUrl({
          authType: grokHelper.AUTH_TYPES.OAUTH,
          baseUrl: 'https://relay.example.com/v1'
        })
      ).toBe(grokHelper.DEFAULT_CLI_BASE_URL)
    })

    it('allows a public HTTPS custom upstream for OAuth overlay mode', () => {
      expect(
        grokHelper.resolveAccountBaseUrl({
          authType: grokHelper.AUTH_TYPES.OAUTH,
          baseUrl: 'https://relay.example.com/xai/v1',
          customUpstream: true
        })
      ).toBe('https://relay.example.com/xai/v1')
    })
  })

  describe('official API key and custom relay', () => {
    it('defaults API-key accounts to the public xAI API', () => {
      expect(
        grokHelper.resolveAccountBaseUrl({
          authType: grokHelper.AUTH_TYPES.API_KEY
        })
      ).toBe(grokHelper.DEFAULT_API_BASE_URL)
    })

    it('accepts regional official API hosts', () => {
      expect(
        grokHelper.resolveAccountBaseUrl({
          authType: grokHelper.AUTH_TYPES.API_KEY,
          baseUrl: 'https://eu-west-1.api.x.ai/v1'
        })
      ).toBe('https://eu-west-1.api.x.ai/v1')
    })

    it('keeps a third-party relay path prefix', () => {
      expect(
        grokHelper.resolveAccountBaseUrl({
          authType: grokHelper.AUTH_TYPES.API_KEY,
          baseUrl: 'https://relay.example.com/xai/v1'
        })
      ).toBe('https://relay.example.com/xai/v1')
    })

    it('rejects private or http custom relays by default', () => {
      expect(() =>
        grokHelper.resolveAccountBaseUrl({
          authType: grokHelper.AUTH_TYPES.API_KEY,
          baseUrl: 'http://relay.example.com/v1'
        })
      ).toThrow(/https/)

      expect(() =>
        grokHelper.resolveAccountBaseUrl({
          authType: grokHelper.AUTH_TYPES.API_KEY,
          baseUrl: 'https://127.0.0.1/v1'
        })
      ).toThrow(/Private/)

      expect(() =>
        grokHelper.resolveAccountBaseUrl({
          authType: grokHelper.AUTH_TYPES.API_KEY,
          baseUrl: 'https://127.0.0.2/v1'
        })
      ).toThrow(/Private/)

      expect(() =>
        grokHelper.resolveAccountBaseUrl({
          authType: grokHelper.AUTH_TYPES.API_KEY,
          baseUrl: 'https://169.254.169.254/v1'
        })
      ).toThrow(/Private/)

      expect(() =>
        grokHelper.resolveAccountBaseUrl({
          authType: grokHelper.AUTH_TYPES.API_KEY,
          baseUrl: 'https://[::1]/v1'
        })
      ).toThrow(/Private/)
    })

    it('rejects official hosts that are not /v1', () => {
      expect(() => grokHelper.validateTrustedBaseURL('https://api.x.ai/openai')).toThrow(/\/v1/)
    })
  })

  describe('OAuth endpoints stay on auth.x.ai', () => {
    it('builds an authorization URL against official auth.x.ai', () => {
      const url = grokHelper.buildAuthorizationURL({
        state: 'abc',
        codeChallenge: 'challenge',
        nonce: 'nonce'
      })
      expect(url.startsWith('https://auth.x.ai/oauth2/authorize?')).toBe(true)
      expect(url).toContain('code_challenge=challenge')
      expect(url).toContain('code_challenge_method=S256')
    })

    it('does not honor an unallowlisted token URL override', () => {
      process.env.XAI_OAUTH_TOKEN_URL = 'https://evil.example/oauth/token'
      expect(() => grokHelper.validateOAuthEndpointURL(grokHelper.effectiveTokenURL())).toThrow()
    })

    it('parses a callback URL, query string, or bare code', () => {
      expect(
        grokHelper.parseAuthorizationInput('http://127.0.0.1:56121/callback?code=abc123&state=xyz')
      ).toEqual({ code: 'abc123', state: 'xyz', requiresState: true })

      expect(grokHelper.parseAuthorizationInput('code=fromquery&state=s')).toEqual({
        code: 'fromquery',
        state: 's',
        requiresState: true
      })

      expect(grokHelper.parseAuthorizationInput('bare-code')).toEqual({
        code: 'bare-code',
        state: '',
        requiresState: false
      })
    })
  })

  describe('CLI identity headers', () => {
    it('stamps CLI identity only for cli-chat-proxy.grok.com', () => {
      const cliHeaders = grokHelper.applyCLIProxyHeaders(
        { Authorization: 'Bearer tok' },
        'https://cli-chat-proxy.grok.com/v1/responses'
      )
      expect(cliHeaders['X-XAI-Token-Auth']).toBe('xai-grok-cli')
      expect(cliHeaders['x-grok-client-identifier']).toBe('grok-shell')
      expect(cliHeaders['x-grok-client-version']).toBe(grokHelper.CLI_CLIENT_VERSION)
      expect(cliHeaders['User-Agent']).toBe(grokHelper.cliUserAgent())

      const apiHeaders = grokHelper.applyCLIProxyHeaders(
        { Authorization: 'Bearer tok' },
        'https://api.x.ai/v1/responses'
      )
      expect(apiHeaders['X-XAI-Token-Auth']).toBeUndefined()
    })

    it('drops CLI version overrides below the stable floor', () => {
      process.env.XAI_GROK_CLI_VERSION = '0.2.1'
      expect(grokHelper.resolveCLIVersion()).toBe(grokHelper.CLI_CLIENT_VERSION)
    })
  })

  describe('path joining', () => {
    it('avoids duplicating /v1 when the base already ends with it', () => {
      expect(grokHelper.joinBaseAndPath('https://api.x.ai/v1', '/v1/chat/completions')).toBe(
        'https://api.x.ai/v1/chat/completions'
      )
      expect(grokHelper.joinBaseAndPath('https://relay.example.com/xai/v1', '/responses')).toBe(
        'https://relay.example.com/xai/v1/responses'
      )
    })
  })

  describe('CLI chat completions rewrite', () => {
    it('maps Chat Completions bodies onto Responses input for the CLI proxy', () => {
      const converted = grokHelper.chatCompletionsToResponsesBody({
        model: 'grok-4.5',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 32,
        stream: false
      })
      expect(converted.messages).toBeUndefined()
      expect(converted.max_tokens).toBeUndefined()
      expect(converted.input).toEqual([{ role: 'user', content: 'hi' }])
      expect(converted.max_output_tokens).toBe(32)
      expect(grokHelper.toResponsesPath('/v1/chat/completions')).toBe('/v1/responses')
      expect(grokHelper.toResponsesPath('/chat/completions')).toBe('/responses')
    })

    it('leaves an already-Responses body unchanged', () => {
      const body = { model: 'grok-4.5', input: [{ role: 'user', content: 'hi' }] }
      expect(grokHelper.chatCompletionsToResponsesBody(body).input).toBe(body.input)
    })
  })
})
