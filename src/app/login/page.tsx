export default function LoginPage() {
  return (
    <main>
      <h1>Sign in</h1>
      <form action="/api/auth/login" method="post">
        <p>
          <label htmlFor="email">Email</label>
          <br />
          <input
            id="email"
            name="email"
            type="email"
            autoComplete="username"
            required
          />
        </p>
        <p>
          <label htmlFor="password">Password</label>
          <br />
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
          />
        </p>
        <button type="submit">Sign in</button>
      </form>
      <form action="/api/auth/recover" method="post">
        <h2>Account recovery</h2>
        <p>
          <label htmlFor="recovery-email">Email</label>
          <br />
          <input
            id="recovery-email"
            name="email"
            type="email"
            autoComplete="username"
            required
          />
        </p>
        <button type="submit">Email a recovery link</button>
      </form>
    </main>
  );
}
