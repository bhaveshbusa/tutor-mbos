export default function UpdatePasswordPage() {
  return (
    <main>
      <h1>Choose a new password</h1>
      <p>This finishes account recovery for the signed-in session.</p>
      <form action="/api/auth/password" method="post">
        <p>
          <label htmlFor="password">New password</label>
          <br />
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="new-password"
            minLength={8}
            maxLength={72}
            required
          />
        </p>
        <button type="submit">Update password</button>
      </form>
    </main>
  );
}
