export default function OnboardingPage() {
  return (
    <main>
      <h1>Create your business</h1>
      <p>
        This creates the one business owned by the signed-in account. Repeating
        it returns that business.
      </p>
      <form action="/api/v1/business" method="post">
        <p>
          <label htmlFor="displayName">Business name</label>
          <br />
          <input id="displayName" name="displayName" required maxLength={120} />
        </p>
        <input type="hidden" name="idempotencyKey" value="browser-onboarding" />
        <button type="submit">Create business</button>
      </form>
    </main>
  );
}
