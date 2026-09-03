(() => {
  const calculator = document.querySelector('[data-calculator]');
  if (!calculator) return;

  const inputs = {
    calls: calculator.querySelector('#calls'),
    missed: calculator.querySelector('#missed'),
    close: calculator.querySelector('#close'),
    job: calculator.querySelector('#job'),
  };
  const money = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  });
  const number = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });

  function update() {
    const calls = Number(inputs.calls.value);
    const missedRate = Number(inputs.missed.value) / 100;
    const closeRate = Number(inputs.close.value) / 100;
    const jobValue = Number(inputs.job.value);
    const missedCalls = calls * 4.33 * missedRate;
    const missedJobs = missedCalls * closeRate;
    const revenue = missedJobs * jobValue;

    calculator.querySelector('[data-value-for="calls"]').value = String(calls);
    calculator.querySelector('[data-value-for="missed"]').value = `${inputs.missed.value}%`;
    calculator.querySelector('[data-value-for="close"]').value = `${inputs.close.value}%`;
    calculator.querySelector('[data-value-for="job"]').value = money.format(jobValue);
    calculator.querySelector('#revenue-output').value = money.format(revenue);
    calculator.querySelector('[data-missed-calls]').textContent =
      `${number.format(missedCalls)} missed calls`;
    calculator.querySelector('[data-jobs]').textContent =
      `${number.format(missedJobs)} potential jobs`;
  }

  Object.values(inputs).forEach((input) => input.addEventListener('input', update));
  update();
})();
