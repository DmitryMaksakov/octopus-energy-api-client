const fetch = require('node-fetch');
const {format, subMonths, setDate, isSameDay, addDays} = require('date-fns');
const { formatInTimeZone } = require('date-fns-tz');

const ELECTRICITY = 'electricity';
const GAS = 'gas';

const API_PREFIX = 'https://api.octopus.energy/v1';

// Requests data pages one by one till maxItems was read
async function getMultiplePagesData(url, maxItems) {
    let nextPageLink = url;

    let result = [];
    do {
        const response = await fetch(nextPageLink);
        const data = await response.json();

        result = [...result, ...data.results];

        nextPageLink = data.next;

        if (result.length > maxItems) {
            result = result.slice(0, maxItems);
            nextPageLink = null;
        }
    } while (nextPageLink);

    return result;
}

// Returns a dictionary of Electricity rates (prices per 1 kwh) by date-time
async function getElectricityRatesByTime(productCode, tariffCode, maxRatesCount) {
    const url = API_PREFIX + `/products/${productCode}/electricity-tariffs/${tariffCode}/standard-unit-rates/`;

    // 31 days by default
    const readings = await getMultiplePagesData(url, maxRatesCount || 2 * 24 * 31)
    const resultByDatetime = {};

    readings.forEach(r => resultByDatetime[r.valid_from] = r.value_inc_vat);

    return resultByDatetime;
}

// Returns price per 1 kwh of gas energy
async function getGasRate(productCode, tariffCode) {
    let url =
        API_PREFIX + `/products/${productCode}/gas-tariffs/${tariffCode}/standard-unit-rates/`;

    const response = await fetch(url);
    const data = await response.json();

    return data.results[0].value_inc_vat;
}

// Returns Standing charge (fix price you pay per day)
async function getStandingCharge(productCode, tariffCode, energyType) {
    const url = API_PREFIX + `/products/${productCode}/${energyType}-tariffs/${tariffCode}/standing-charges/`;
    const response = await fetch(url);
    const data = await response.json();

    return data.results[0].value_inc_vat;
}

// Returns meter readings
async function getReadings(mpan, serialNumber, energyType, maxReadingsCount) {
    const url = API_PREFIX + `https://api.octopus.energy/v1/${energyType}-meter-points/${mpan}/meters/${serialNumber}/consumption/`;
    return await getMultiplePagesData(url, maxReadingsCount || 2 * 24 * 31)
}

// Returns Readings in form of dictionary [timestamp -> consumed energy]
function readingsToDict(readings) {
    const result = {};

    readings.forEach(r => result[r.interval_start] = r.consumption);

    return result;
}

// Returns Readings in form of dictionary [date (yyyy-MM-dd) -> consumed energy]
function sumReadingsByDay(readings) {
    const result = {};

    readings.forEach(r => {
        const key = r.interval_start.substring(0, 10);

        result[key] = (result[key] || 0) + r.consumption;
    });

    return result;
}

// Returns average energy consumption by provided days
function getAverageConsumptionPerPeriod(groupedReadings) {
    let sum = 0;
    let daysNumber = 0;

    for (let day in groupedReadings) {
        sum += groupedReadings[day];
        daysNumber++;
    }

    return sum / daysNumber;
}

// Returns price in pence for used electricity on the selected date
function getElectricityPriceByDate(readings, ratesDict, date) {
    const readingsDict = readingsToDict(readings);

    let result = 0;
    for (let h = 0; h <= 23; h++) {
        for (let m = 0; m <= 30; m += 30) {
            date.setHours(h);
            date.setMinutes(m);
            date.setSeconds(0);

            const timestamp = format(date, 'yyyy-MM-dd HH:mm:ss').replace(' ', 'T') + '+01:00';
            const timestampUTC = formatInTimeZone(date, 'UTC', 'yyyy-MM-dd HH:mm:ss').replace(' ', 'T') + 'Z';

            const reading = readingsDict[timestampUTC] || readingsDict[timestamp] || 0;
            const rate = ratesDict[timestampUTC] || ratesDict[timestamp] || 0;

            result += reading * rate;
        }
    }

    return result;
}

// Returns the best start time to use electricity for given period of hours (hCount) at given date (date)
function getBestConsumptionTime(ratesDict, date, hCount, startHour) {
    const costByTime = {};

    for (let h = startHour || 0; h <= 23.5 - hCount; h += 0.5) {
        costByTime[h] = 0;

        for (let hd = 0; hd < hCount; hd += 0.5) {
            const hi = h + hd;

            date.setHours(Math.trunc(hi));
            date.setMinutes(hi % 1 === 0 ? 0 : 30);
            date.setSeconds(0);

            const timestamp = format(date, 'yyyy-MM-dd HH:mm:ss').replace(' ', 'T') + '+01:00';
            const timestampUTC = formatInTimeZone(date, 'UTC', 'yyyy-MM-dd HH:mm:ss').replace(' ', 'T') + 'Z';

            const rate = ratesDict[timestampUTC] || ratesDict[timestamp];

            costByTime[h] += rate;
        }
    }

    let minCostH = -1;
    let minCost = Number.MAX_VALUE;
    for (let h in costByTime) {
        if (costByTime[h] < minCost) {
            minCost = costByTime[h];
            minCostH = h;
        }
    }

    return minCostH;
}

// Returns boolean value, checks if data on the specific date is available
async function checkIfDataAvailable(mpan, serialNumber, energyType, date) {
    const url = API_PREFIX + `https://api.octopus.energy/v1/${energyType}-meter-points/${mpan}/meters/${serialNumber}/consumption/`;
    const lastReading = await getReadings(url, 10);

    return lastReading.length > 4 && lastReading[3] && lastReading[3].interval_start.includes(date);
}

// Returns billing start date based on the billing day
function getBillingStartDate(billingDay) {
    const today = new Date();

    let billingStartDate = null;
    if (today.getDate() < billingDay) {
        billingStartDate = setDate(subMonths(today, 1), billingDay);
    } else {
        billingStartDate = setDate(today, billingDay);
    }

    return billingStartDate;
}

// Returns electricity usage in kwh and pences starting from the billing day of the month
function getElectricityConsumptionForBillingPeriod(readings, usageByDay, ratesDict, standingCharge, billingDay) {
    const billingStartDate = getBillingStartDate(billingDay || 1);
    const today = new Date();

    const result = {
        price: 0,
        kWh: 0,
        billingStartDate
    };

    let d = billingStartDate;

    do {
        const formattedDate = format(d, 'yyyy-MM-dd');

        result.price += (getElectricityPriceByDate(readings, ratesDict, d) || 0) + standingCharge;
        result.kWh += usageByDay[formattedDate] || 0;

        d = addDays(d, 1);
    } while (!isSameDay(d, today));

    return result;
}

// Returns gas usage in kwh and pences starting from the billing day of the month
function getGasConsumptionForBillingPeriod(usageByDay, rate, standingCharge, m3ToKWh, billingDay) {
    const billingStartDate = getBillingStartDate(billingDay)
    const today = new Date();

    const result = {
        price: 0,
        kWh: 0,
        billingStartDate
    };

    let d = billingStartDate;

    do {
        const formattedDate = format(d, 'yyyy-MM-dd');

        result.price += (usageByDay[formattedDate] || 0) * m3ToKWh * rate + standingCharge;
        result.kWh += usageByDay[formattedDate] * m3ToKWh || 0;

        d = addDays(d, 1);
    } while (!isSameDay(d, today));

    return result;
}

// Returns a full data set for Electricity for desired date
async function getElectricityReport(productCode, tariffCode, mpan, serialNumber, date, options) {
    try {
        const isReadingsAvailable =
            await checkIfDataAvailable(mpan, serialNumber, ELECTRICITY, format(date, 'yyyy-MM-dd'));

        if (!isReadingsAvailable) {
            return {
                isDataAvailable: false
            }
        }

        const readings = await getReadings(mpan, serialNumber, ELECTRICITY);
        const usageByDay = sumReadingsByDay(readings);

        const kWh = usageByDay[format(date, 'yyyy-MM-dd')];
        const kWhAvg = getAverageConsumptionPerPeriod(usageByDay);

        const rates = await getElectricityRatesByTime(productCode, tariffCode);
        const standingCharge = await getStandingCharge(productCode, tariffCode, ELECTRICITY);

        const price = getElectricityPriceByDate(readings, rates, date);

        let billingPeriod = undefined;
        if (options.billingPeriodDay) {
            billingPeriod =
                getElectricityConsumptionForBillingPeriod(
                    readings, usageByDay, rates, standingCharge, options.billingPeriodDay
                );
        }

        let bestConsumptionTimes = undefined;
        if (options.usageIntervals) {
            bestConsumptionTimes = {};

            options.usageIntervals.forEach(h => {
                const intH = parseInt(h);

                bestConsumptionTimes[intH] =
                    getBestConsumptionTime(rates, addDays(date, 1), intH, options.usageIntervalsStartHour);
            });
        }

        return {
            kWh,
            kWhAvg,
            standingCharge,
            rates,
            price,

            bestConsumptionTimes,

            billingPeriod,

            date,

            isDataAvailable: true
        }
    } catch (e) {
        return {
            isDataAvailable: false,
            error: e
        }
    }
}

// Returns a full data set for Gas for desired date
async function getGasReport(productCode, tariffCode, mpan, serialNumber, m3ToKwh, date, options) {
    try {
        const isReadingsAvailable =
            await checkIfDataAvailable(mpan, serialNumber, GAS, format(date, 'yyyy-MM-dd'));

        if (!isReadingsAvailable) {
            return {
                isDataAvailable: false
            }
        }

        const readings = await getReadings(mpan, serialNumber, GAS);
        const usageByDay = sumReadingsByDay(readings);

        const kWh = usageByDay[format(date, 'yyyy-MM-dd')] * m3ToKwh;
        const kWhAvg = getAverageConsumptionPerPeriod(usageByDay) * m3ToKwh;

        const standingCharge = await getStandingCharge(productCode, tariffCode, GAS);
        const rate = await getGasRate();

        const price = kWh * rate;

        let billingPeriod = undefined;
        if (options.billingPeriodDay) {
            billingPeriod =
                getGasConsumptionForBillingPeriod(usageByDay, rate, standingCharge, m3ToKwh, options.billingPeriodDay);
        }

        return {
            kWh,
            kWhAvg,
            standingCharge,
            rate,
            price,

            billingPeriod,

            date,

            isDataAvailable: true
        }
    } catch (e) {
        return {
            isDataAvailable: false,
            error: e
        }
    }
}

module.exports = {
    getMultiplePagesData,
    getElectricityRatesByTime,
    getGasRate,
    getStandingCharge,
    getReadings,
    readingsToDict,
    sumReadingsByDay,
    getAverageConsumptionPerPeriod,
    getElectricityPriceByDate,
    getBestConsumptionTime,
    checkIfDataAvailable,
    getBillingStartDate,
    getElectricityConsumptionForBillingPeriod,
    getGasConsumptionForBillingPeriod,
    getElectricityReport,
    getGasReport
}