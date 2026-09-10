require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// Simple deterministic pricing config - not calculated by LLM
const TAX_RATE = parseFloat(process.env.TAX_RATE) || 0.08;
const DELIVERY_FEE = parseFloat(process.env.DELIVERY_FEE) || 3.00;

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'frontend')));

var sessions = {};

function createSession() {
  return crypto.randomBytes(8).toString('hex');
}

function initOrder(sessionId) {
  if (!sessions[sessionId]) {
    sessions[sessionId] = {
      items: [],
      orderType: null,
      customerDetails: { name: '', phone: '', pickupTime: null, address: '', apartmentUnit: '', deliveryInstructions: '' },
      deliveryAddressConfirmed: false,
      promotion: null,
      breakdown: null,
      total: 0,
      confirmation: false,
      status: 'open'
    };
  }
  return sessions[sessionId];
}

function getOrder(sessionId) {
  return sessions[sessionId] || null;
}

function readFile(filePath) {
  return fs.readFileSync(path.join(__dirname, '..', filePath), 'utf-8');
}

function loadMenu() {
  return JSON.parse(readFile('data/menu.json')).menu.items;
}

function formatMenu() {
  var items = loadMenu().filter(function (item) { return item.available !== false; });
  var categories = {};
  items.forEach(function (item) {
    if (!categories[item.category]) {
      categories[item.category] = [];
    }
    categories[item.category].push(item);
  });

  var labels = { coffee: 'Coffee', tea: 'Tea', pastries: 'Pastries' };
  var text = 'Here is our menu:\n\n';

  Object.keys(categories).forEach(function (key) {
    text += labels[key] || key + '\n';
    categories[key].forEach(function (item) {
      text += '- ' + item.name + ' ($' + item.price.toFixed(2) + ')\n';
    });
    text += '\n';
  });

  return text;
}

function findMenuItem(id) {
  var items = loadMenu();
  return items.find(function (item) { return item.id === id; }) || null;
}

function findItemByName(name) {
  var items = loadMenu();
  var matched = null;
  items.forEach(function (item) {
    if (name.includes(item.name.toLowerCase())) {
      matched = item;
    }
  });
  return matched;
}

function itemNeedsOptions(item) {
  return item.sizes && item.sizes.length > 0 && item.sizes[0] !== 'Standard';
}

function getMissingOptions(item, selectedOptions) {
  if (!itemNeedsOptions(item)) return [];
  if (!selectedOptions || selectedOptions.length === 0) {
    return item.sizes;
  }
  // Require exactly one valid size; otherwise prompt for valid options
  if (selectedOptions.length === 1 && item.sizes.includes(selectedOptions[0])) {
    return [];
  }
  return item.sizes;
}

function loadActivePromotions() {
  const data = JSON.parse(readFile('data/promotions.json'));
  return data.promotions.filter(function (p) { return p.active; });
}

function checkPromotionEligibility(promotion, order) {
  var elig = promotion.eligibility || {};
  var now = new Date();

  if (elig.time_window) {
    var hour = now.getHours();
    if (elig.time_window === 'before 10:00 AM' && hour >= 10) {
      return { eligible: false, reason: 'Morning Happy Hour is only available before 10:00 AM.' };
    }
  }

  if (elig.days_of_week && elig.days_of_week.length > 0) {
    var dayName = now.toLocaleString('en-US', { weekday: 'long' });
    if (!elig.days_of_week.includes(dayName)) {
      return { eligible: false, reason: 'This promotion is only available on ' + elig.days_of_week.join(' or ') + '.' };
    }
  }

  if (elig.min_order !== null && elig.min_order !== undefined) {
    var subtotal = 0;
    order.items.forEach(function (i) {
      var item = findMenuItem(i.id);
      if (item) {
        subtotal += item.price * i.quantity;
      }
    });
    if (subtotal < elig.min_order) {
      return { eligible: false, reason: 'Minimum order of $' + elig.min_order.toFixed(2) + ' is required for this promotion.' };
    }
  }

  if (elig.requires_purchase) {
    var hasRequired = order.items.some(function (i) {
      if (i.id === elig.requires_purchase) return true;
      if (elig.requires_purchase === 'coffee') {
        var menuItem = findMenuItem(i.id);
        return menuItem && menuItem.category === 'coffee';
      }
      return false;
    });
    if (!hasRequired) {
      return { eligible: false, reason: 'This promotion requires a coffee purchase first.' };
    }
  }

  if (elig.eligible_items && elig.eligible_items.length > 0) {
    var hasEligibleItem = order.items.some(function (i) {
      return elig.eligible_items.includes(i.id);
    });
    if (!hasEligibleItem) {
      return { eligible: false, reason: 'No eligible items in your current order.' };
    }
  }

  return { eligible: true };
}

function getEligiblePromotions(order) {
  var all = loadActivePromotions();
  return all.filter(function (p) {
    return checkPromotionEligibility(p, order).eligible;
  });
}

function recommendPromotions(order) {
  var eligible = getEligiblePromotions(order);
  if (eligible.length === 0) return '';
  var text = '\n\nAvailable promotions:\n';
  eligible.forEach(function (p) {
    text += '- ' + p.name + ': ' + p.rule + '\n';
  });
  text += 'Ask us to apply one!';
  return text;
}

function applyPromotion(sessionId, promotionId) {
  var order = initOrder(sessionId);
  var active = loadActivePromotions().find(function (p) { return p.id === promotionId; });
  if (!active) return { success: false, error: 'Promotion not found.' };

  var check = checkPromotionEligibility(active, order);
  if (!check.eligible) return { success: false, error: check.reason };

  order.promotion = promotionId;
  order.total = calculateTotal(order);
  return { success: true };
}

function addToOrder(sessionId, itemId, quantity, options) {
  var order = initOrder(sessionId);
  var item = findMenuItem(itemId);
  if (!item) return null;
  if (item.available === false) return null;

  var existing = order.items.find(function (i) { return i.id === itemId; });
  if (existing) {
    existing.quantity += quantity;
  } else {
    order.items.push({ id: item.id, name: item.name, quantity: quantity, options: options || [] });
  }

  order.total = calculateTotal(order);
  return order;
}

function calculateOrderBreakdown(order) {
  // Deterministic: uses only menu.json prices, never LLM output
  var subtotal = 0;
  order.items.forEach(function (i) {
    var item = findMenuItem(i.id);
    if (item) {
      subtotal += item.price * i.quantity;
    }
  });
  subtotal = parseFloat(subtotal.toFixed(2));

  var discount = 0;
  if (order.promotion) {
    var promo = loadActivePromotions().find(function (p) { return p.id === order.promotion; });
    if (promo) {
      var check = checkPromotionEligibility(promo, order);
      if (check.eligible) {
        if (promo.discount.type === 'percentage') {
          discount = parseFloat((subtotal * (promo.discount.value / 100)).toFixed(2));
        } else if (promo.discount.type === 'free_item') {
          var freeItem = findMenuItem(promo.discount.item_id);
          if (freeItem) {
            discount = parseFloat(freeItem.price.toFixed(2));
          }
        }
      } else {
        order.promotion = null;
      }
    }
  }

  var subtotalAfterDiscount = parseFloat((subtotal - discount).toFixed(2));
  if (subtotalAfterDiscount < 0) subtotalAfterDiscount = 0;

  var tax = parseFloat((subtotalAfterDiscount * TAX_RATE).toFixed(2));
  var deliveryFee = order.orderType === 'delivery' ? parseFloat(DELIVERY_FEE.toFixed(2)) : 0;
  var total = parseFloat((subtotalAfterDiscount + tax + deliveryFee).toFixed(2));

  return {
    subtotal: subtotal,
    discount: discount,
    subtotalAfterDiscount: subtotalAfterDiscount,
    tax: tax,
    deliveryFee: deliveryFee,
    total: total,
    taxRate: TAX_RATE,
    currency: 'USD'
  };
}

function calculateTotal(order) {
  var breakdown = calculateOrderBreakdown(order);
  order.breakdown = breakdown;
  return breakdown.total;
}

function confirmOrder(sessionId) {
  var order = initOrder(sessionId);
  if (order.items.length === 0) return false;
  if (order.orderType === 'pickup') {
    var missing = hasMissingPickupInfo(order);
    if (missing.length > 0) return false;
  }
  if (order.orderType === 'delivery') {
    var missing = hasMissingDeliveryInfo(order);
    if (missing.length > 0) return false;
    if (!order.deliveryAddressConfirmed) return false;
  }
  order.confirmation = true;
  order.status = 'confirmed';
  return true;
}

function classifyMessage(text) {
  var lower = text.toLowerCase().trim();

  var matchedItem = findItemByName(lower);
  if (matchedItem) {
    var detectedOption = null;
    if (matchedItem.sizes) {
      for (var s = 0; s < matchedItem.sizes.length; s++) {
        if (lower.includes(matchedItem.sizes[s].toLowerCase())) {
          detectedOption = matchedItem.sizes[s];
          break;
        }
      }
    }
    return { action: 'add_item', item: matchedItem, detectedOption: detectedOption };
  }

  if (lower.includes('menu') || lower.includes('what do you') || lower.includes('drinks') || lower.includes('tea') || lower.includes('coffee') || lower.includes('food')) {
    return 'menu';
  }
  if (lower.includes('order') || lower.includes('buy') || lower.includes('i want') || lower.includes('i would like') || lower.includes('can i get')) {
    return 'order';
  }
  if (lower.includes('hour') || lower.includes('open') || lower.includes('time')) {
    return 'hours';
  }
  if (lower.includes('bye') || lower.includes('goodbye') || lower.includes('see you') || lower.includes('thank')) {
    return 'closing';
  }
  return 'default';
}

function classifyPickupMessage(text) {
  var lower = text.toLowerCase().trim();
  var result = { pickup: false, name: null, pickupTime: null };

  if (lower.includes('pickup') || lower.includes('pick up') || lower.includes('for pickup') || lower.includes('pick up order')) {
    result.pickup = true;
  }

  var nameMatch = lower.match(/(?:my name is|i am|i'm|name:)\s+([a-zA-Z\s]+)/);
  if (nameMatch) {
    result.name = nameMatch[1].trim();
  }

  var timeMatch = lower.match(/(?:at|for|pickup at|ready at)\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/i);
  if (timeMatch) {
    result.pickupTime = timeMatch[1].trim();
  }

  return result;
}

function hasMissingPickupInfo(order) {
  if (!order || order.orderType !== 'pickup') return [];
  var missing = [];
  if (!order.customerDetails.name) missing.push('name');
  if (!order.customerDetails.pickupTime) missing.push('pickup time');
  return missing;
}

function updatePickupInfo(sessionId, name, pickupTime) {
  var order = initOrder(sessionId);
  if (name) order.customerDetails.name = name;
  if (pickupTime) order.customerDetails.pickupTime = pickupTime;
  calculateTotal(order);
  return order;
}

function classifyDeliveryMessage(text) {
  var lower = text.toLowerCase().trim();
  var result = { delivery: false, name: null, phone: null, address: null, apartmentUnit: null, instructions: null };

  if (lower.includes('delivery') || lower.includes('deliver') || lower.includes('delivered to') || lower.includes('ship to')) {
    result.delivery = true;
  }

  var nameMatch = lower.match(/(?:my name is|i am|i'm|name:)\s+([a-zA-Z\s]+)/);
  if (nameMatch) {
    result.name = nameMatch[1].trim();
  }

  var phoneMatch = lower.match(/((?:\+?\d{1,3}[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)?\d{3}[-.\s]?\d{4})/);
  if (phoneMatch) {
    result.phone = phoneMatch[1].trim();
  }

  var addressMatch = lower.match(/(?:at|address|to)\s+(\d+\s+[a-zA-Z\s]+(?:street|st|avenue|ave|road|rd|lane|ln|blvd|drive|dr|way|ct|court|circle|pl|place|boulevard| Blvd| St| Ave| Rd)\.?)/i);
  if (addressMatch) {
    result.address = addressMatch[1].trim();
  }

  var aptMatch = lower.match(/(?:apt|apartment|unit|suite|#)\s*([a-zA-Z0-9]+)/i);
  if (aptMatch) {
    result.apartmentUnit = aptMatch[1].trim();
  }

  var instrMatch = lower.match(/(?:instructions?|notes?|special|leave\s+at|ring\s+bell|leave\s+behind)\s+[:—\-]?\s*([a-zA-Z\s]+)/i);
  if (instrMatch && instrMatch[1].length > 3) {
    result.instructions = instrMatch[1].trim();
  }

  return result;
}

function hasMissingDeliveryInfo(order) {
  if (!order || order.orderType !== 'delivery') return [];
  var missing = [];
  if (!order.customerDetails.name) missing.push('name');
  if (!order.customerDetails.phone) missing.push('phone number');
  if (!order.customerDetails.address) missing.push('delivery address');
  // apartment/unit is optional - only if applicable, never guess
  return missing;
}

function updateDeliveryInfo(sessionId, data) {
  var order = initOrder(sessionId);
  var addressChanged = false;
  if (data.name) order.customerDetails.name = data.name;
  if (data.phone) order.customerDetails.phone = data.phone;
  if (data.address) { order.customerDetails.address = data.address; addressChanged = true; }
  if (data.apartmentUnit) { order.customerDetails.apartmentUnit = data.apartmentUnit; addressChanged = true; }
  if (data.instructions) { order.customerDetails.deliveryInstructions = data.instructions; addressChanged = true; }
  if (addressChanged) {
    order.deliveryAddressConfirmed = false;
  }
  calculateTotal(order);
  return order;
}

function formatFullDeliveryAddress(order) {
  var d = order.customerDetails;
  var parts = [];
  if (d.address) parts.push(d.address);
  if (d.apartmentUnit) parts.push('Unit ' + d.apartmentUnit);
  if (d.deliveryInstructions) parts.push('Instructions: ' + d.deliveryInstructions);
  return parts.join(', ');
}

function confirmDeliveryAddress(sessionId) {
  var order = getOrder(sessionId);
  if (!order || order.orderType !== 'delivery') return { error: 'Not a delivery order.' };
  var missing = hasMissingDeliveryInfo(order);
  if (missing.length > 0) return { error: 'Missing delivery information: ' + missing.join(', ') };
  order.deliveryAddressConfirmed = true;
  return { order: order };
}

function correctDeliveryAddress(sessionId, data) {
  var order = getOrder(sessionId);
  if (!order || order.orderType !== 'delivery') return { error: 'Not a delivery order.' };
  updateDeliveryInfo(sessionId, data);
  // stays unconfirmed until explicitly confirmed, even if no missing fields
  return { order: order, needsConfirmation: true, fullAddress: formatFullDeliveryAddress(order) };
}

function formatOrderSummary(order) {
  var text = '\n\nCurrent order:\n';
  order.items.forEach(function (i) {
    var customization = i.options && i.options.length > 0 ? ' [' + i.options.join(', ') + ']' : '';
    text += '- ' + i.name + ' x' + i.quantity + customization + '\n';
  });
  // Deterministic breakdown - never from LLM
  var bd = order.breakdown || calculateOrderBreakdown(order);
  text += 'Subtotal: $' + bd.subtotal.toFixed(2) + '\n';
  if (bd.discount > 0) {
    text += 'Discount: -$' + bd.discount.toFixed(2) + '\n';
  }
  text += 'Tax (' + Math.round(bd.taxRate * 100) + '%): $' + bd.tax.toFixed(2) + '\n';
  if (bd.deliveryFee > 0) {
    text += 'Delivery fee: $' + bd.deliveryFee.toFixed(2) + '\n';
  }
  text += 'Total: $' + bd.total.toFixed(2) + '\n';
  text += 'Status: ' + order.status;
  if (order.orderType === 'delivery') {
    var d = order.customerDetails;
    text += '\nDelivery to: ' + d.address + (d.apartmentUnit ? ' (Unit ' + d.apartmentUnit + ')' : '');
    if (d.deliveryInstructions) {
      text += '\nInstructions: ' + d.deliveryInstructions;
    }
  }
  if (order.orderType === 'pickup') {
    var d = order.customerDetails;
    if (d.pickupTime) {
      text += '\nPickup at: ' + d.pickupTime;
    }
  }
  return text;
}

function buildStructuredOrderSummary(order) {
  if (!order) return null;
  var breakdown = order.breakdown || calculateOrderBreakdown(order);
  // ensure latest total is stored
  order.breakdown = breakdown;
  order.total = breakdown.total;

  var items = order.items.map(function (i) {
    var menuItem = findMenuItem(i.id);
    var unitPrice = menuItem ? menuItem.price : 0;
    return {
      id: i.id,
      name: i.name,
      description: menuItem ? menuItem.description : '',
      quantity: i.quantity,
      customizations: i.options || [],
      options: i.options || [],
      unitPrice: parseFloat(unitPrice.toFixed(2)),
      lineTotal: parseFloat((unitPrice * i.quantity).toFixed(2)),
      available: menuItem ? menuItem.available : true
    };
  });

  var fulfillment = null;
  if (order.orderType === 'delivery') {
    fulfillment = {
      type: 'delivery',
      name: order.customerDetails.name,
      phone: order.customerDetails.phone,
      address: order.customerDetails.address,
      apartmentUnit: order.customerDetails.apartmentUnit,
      deliveryInstructions: order.customerDetails.deliveryInstructions,
      fullAddress: formatFullDeliveryAddress(order),
      addressConfirmed: !!order.deliveryAddressConfirmed
    };
  } else if (order.orderType === 'pickup') {
    fulfillment = {
      type: 'pickup',
      name: order.customerDetails.name,
      pickupTime: order.customerDetails.pickupTime
    };
  } else {
    fulfillment = { type: null };
  }

  var appliedPromotion = null;
  if (order.promotion) {
    var promo = loadActivePromotions().find(function (p) { return p.id === order.promotion; });
    if (promo && checkPromotionEligibility(promo, order).eligible) {
      appliedPromotion = {
        id: promo.id,
        name: promo.name,
        rule: promo.rule,
        discount: promo.discount
      };
    }
  }

  var validPromotions = getEligiblePromotions(order).map(function (p) {
    return { id: p.id, name: p.name, rule: p.rule, discount: p.discount, eligible_items: p.eligible_items };
  });

  return {
    items: items,
    fulfillment: fulfillment,
    promotions: {
      applied: appliedPromotion,
      valid: validPromotions
    },
    totals: breakdown,
    status: order.status,
    confirmation: order.confirmation
  };
}

function formatStructuredSummaryText(summary) {
  if (!summary || summary.items.length === 0) {
    return 'Your order is empty.';
  }
  var lines = [];
  lines.push('Order Summary:');
  summary.items.forEach(function (item) {
    var custom = item.customizations.length > 0 ? ' [' + item.customizations.join(', ') + ']' : '';
    lines.push('- ' + item.name + ' x' + item.quantity + custom + ' @ $' + item.unitPrice.toFixed(2) + ' = $' + item.lineTotal.toFixed(2));
  });
  lines.push('Subtotal: $' + summary.totals.subtotal.toFixed(2));
  if (summary.totals.discount > 0) {
    var promoName = summary.promotions.applied ? ' (' + summary.promotions.applied.name + ')' : '';
    lines.push('Discount' + promoName + ': -$' + summary.totals.discount.toFixed(2));
  }
  lines.push('Tax (' + Math.round(summary.totals.taxRate * 100) + '%): $' + summary.totals.tax.toFixed(2));
  if (summary.totals.deliveryFee > 0) {
    lines.push('Delivery fee: $' + summary.totals.deliveryFee.toFixed(2));
  }
  lines.push('Total: $' + summary.totals.total.toFixed(2));
  if (summary.fulfillment.type === 'delivery') {
    lines.push('Fulfillment: Delivery to ' + summary.fulfillment.fullAddress);
    lines.push('Contact: ' + summary.fulfillment.name + ' ' + summary.fulfillment.phone);
  } else if (summary.fulfillment.type === 'pickup') {
    lines.push('Fulfillment: Pickup for ' + summary.fulfillment.name + ' at ' + summary.fulfillment.pickupTime);
  }
  if (summary.promotions.valid.length > 0 && !summary.promotions.applied) {
    lines.push('Valid promotions: ' + summary.promotions.valid.map(function (p) { return p.name; }).join(', '));
  }
  return lines.join('\n');
}

function generateOrderId() {
  return 'ORD-' + Date.now() + '-' + crypto.randomBytes(3).toString('hex').toUpperCase();
}

function saveConfirmedOrder(sessionId, summary) {
  // Only save confirmed orders - never drafts
  if (!summary || summary.status !== 'confirmed' || summary.confirmation !== true) {
    return null;
  }
  var ordersPath = path.join(__dirname, '..', 'data', 'orders.json');
  var orders = [];
  try {
    var raw = fs.readFileSync(ordersPath, 'utf-8');
    orders = JSON.parse(raw);
    if (!Array.isArray(orders)) orders = [];
  } catch (e) {
    orders = [];
  }
  var record = {
    orderId: generateOrderId(),
    sessionId: sessionId,
    timestamp: new Date().toISOString(),
    status: 'confirmed',
    summary: summary
  };
  orders.push(record);
  fs.writeFileSync(ordersPath, JSON.stringify(orders, null, 2), 'utf-8');
  return record;
}

function recommendItems(order) {
  var items = loadMenu();
  var orderedIds = {};
  if (order && order.items) {
    order.items.forEach(function (i) { orderedIds[i.id] = true; });
  }
  var available = items.filter(function (item) { return !orderedIds[item.id]; });
  if (available.length === 0) return [];
  return available.slice(0, 2);
}

function formatRecommendations(order) {
  var recs = recommendItems(order);
  if (recs.length === 0) return '';
  var text = '\n\nYou might also like:\n';
  recs.forEach(function (item) {
    text += '- ' + item.name + ' ($' + item.price.toFixed(2) + ')\n';
  });
  text += 'No pressure — just a suggestion!';
  return text;
}

function buildResponse(action, history, order) {
  var systemPrompt = loadSystemPrompt();

  if (typeof action === 'object' && action.item) {
    var item = action.item;
    if (item.available === false) {
      return {
        systemPrompt: systemPrompt,
        text: 'Sorry, ' + item.name + ' is currently unavailable. Please choose from our available menu: ' + loadMenu().filter(function (i) { return i.available !== false; }).map(function (i) { return i.name; }).join(', ') + '.',
        action: 'unavailable',
        timestamp: new Date().toISOString()
      };
    }
    var selectedForCheck = action.detectedOption ? [action.detectedOption] : [];
    var missing = getMissingOptions(item, selectedForCheck);
    if (missing.length > 0) {
      return {
        systemPrompt: systemPrompt,
        text: 'Great choice! ' + item.name + ' is available. Which size would you like? Options: ' + missing.join(', ') + '.',
        action: 'add_item',
        pendingItem: { id: item.id, name: item.name, quantity: 1 },
        missingOptions: missing,
        timestamp: new Date().toISOString()
      };
    }
    return {
      systemPrompt: systemPrompt,
      text: 'Great choice! ' + item.name + ' added to your order.',
      action: 'add_item',
      addedItem: { id: item.id, name: item.name, quantity: 1 },
      timestamp: new Date().toISOString()
    };
  }

  if (order && order.orderType === 'pickup') {
    var missingPickup = hasMissingPickupInfo(order);
    if (missingPickup.length > 0) {
      var msg = 'For pickup, I need a few more details. ';
      if (missingPickup.includes('name')) msg += 'What is your name? ';
      if (missingPickup.includes('pickup time')) msg += 'What time would you like to pick it up? ';
      return {
        systemPrompt: systemPrompt,
        text: msg,
        action: 'pickup',
        missingPickup: missingPickup,
        timestamp: new Date().toISOString()
      };
    }
  }

  if (order && order.orderType === 'delivery') {
    var missingDelivery = hasMissingDeliveryInfo(order);
    if (missingDelivery.length > 0) {
      var msg = 'For delivery, I need a few more details. ';
      if (missingDelivery.includes('name')) msg += 'What is your name? ';
      if (missingDelivery.includes('phone number')) msg += 'What is your phone number? ';
      if (missingDelivery.includes('delivery address')) msg += 'What is your full delivery address? ';
      if (missingDelivery.includes('apartment/unit')) msg += 'What is your apartment/unit number? ';
      return {
        systemPrompt: systemPrompt,
        text: msg,
        action: 'delivery',
        missingDelivery: missingDelivery,
        timestamp: new Date().toISOString()
      };
    }
    if (!order.deliveryAddressConfirmed) {
      var fullAddress = formatFullDeliveryAddress(order);
      return {
        systemPrompt: systemPrompt,
        text: 'Please confirm your delivery address: ' + fullAddress + '. Reply "confirm" to confirm or provide the corrected address.',
        action: 'delivery_confirm',
        fullAddress: fullAddress,
        timestamp: new Date().toISOString()
      };
    }
  }

  var responses = {
    menu: formatMenu(),
    order: 'Thanks for your order! I will confirm the details shortly. Is there anything else?',
    hours: 'We are open daily from 7:00 AM to 7:00 PM. Come visit us!',
    closing: 'Thanks for chatting with CafeBot! Have a wonderful day. ☕',
    default: 'Sure! Let me know how I can help. Would you like to see the menu, place an order, or check our hours?'
  };

  var responseText = responses[action] || responses.default;

  if (order && order.items.length > 0) {
    responseText += formatOrderSummary(order);
    responseText += formatRecommendations(order);
  }

  return {
    systemPrompt: systemPrompt,
    text: responseText,
    action: action,
    timestamp: new Date().toISOString()
  };
}

app.post('/api/chat', function (req, res) {
  var message = req.body.message;
  var history = req.body.history || [];
  var sessionId = req.body.sessionId || createSession();
  var order = getOrder(sessionId);

  if (!message || typeof message !== 'string' || message.trim().length === 0) {
    return res.status(400).json({ error: 'Message is required and must be a non-empty string.' });
  }

  var action = classifyMessage(message);
  var pickupInfo = classifyPickupMessage(message);
  var deliveryInfo = classifyDeliveryMessage(message);

  if (deliveryInfo.delivery || deliveryInfo.name || deliveryInfo.phone || deliveryInfo.address || deliveryInfo.apartmentUnit || deliveryInfo.instructions) {
    order = initOrder(sessionId);
    if (deliveryInfo.name) order.customerDetails.name = deliveryInfo.name;
    if (deliveryInfo.phone) order.customerDetails.phone = deliveryInfo.phone;
    if (deliveryInfo.address) { order.customerDetails.address = deliveryInfo.address; order.deliveryAddressConfirmed = false; }
    if (deliveryInfo.apartmentUnit) { order.customerDetails.apartmentUnit = deliveryInfo.apartmentUnit; order.deliveryAddressConfirmed = false; }
    if (deliveryInfo.instructions) { order.customerDetails.deliveryInstructions = deliveryInfo.instructions; order.deliveryAddressConfirmed = false; }
    if (deliveryInfo.delivery && !order.orderType) {
      order.orderType = 'delivery';
    }
    calculateTotal(order);
    var missingDelivery = hasMissingDeliveryInfo(order);
    var responseText = '';
    var responseAction = 'delivery';
    if (missingDelivery.length > 0) {
      responseText = 'For delivery, I need a few more details. ';
      if (missingDelivery.includes('name')) responseText += 'What is your name? ';
      if (missingDelivery.includes('phone number')) responseText += 'What is your phone number? ';
      if (missingDelivery.includes('delivery address')) responseText += 'What is your full delivery address? ';
      if (missingDelivery.includes('apartment/unit')) responseText += 'What is your apartment/unit number? ';
    } else if (!order.deliveryAddressConfirmed) {
      var fullAddress = formatFullDeliveryAddress(order);
      responseText = 'Please confirm your delivery address: ' + fullAddress + '. Reply "confirm" to confirm or provide the corrected address.';
      responseAction = 'delivery_confirm';
    } else if (order.items.length > 0) {
      responseText = 'Delivery details noted! Here is your order:';
    } else {
      responseText = 'Delivery order noted! Would you like to see the menu?';
    }
    var response = {
      systemPrompt: loadSystemPrompt(),
      text: responseText,
      action: responseAction,
      timestamp: new Date().toISOString()
    };
    if (responseAction === 'delivery_confirm') {
      response.fullAddress = formatFullDeliveryAddress(order);
    }
    history.push({ sender: 'customer', text: message, timestamp: new Date().toISOString() });
    history.push({ sender: 'bot', text: responseText, timestamp: new Date().toISOString(), action: responseAction });
    res.json({ sessionId: sessionId, response: response, order: order, history: history });
    return;
  }

  // Explicit delivery address confirmation / correction via chat when already in delivery mode
  if (order && order.orderType === 'delivery' && hasMissingDeliveryInfo(order).length === 0 && !order.deliveryAddressConfirmed) {
    var lowerConfirm = message.toLowerCase().trim();
    var isConfirm = lowerConfirm === 'confirm' || lowerConfirm === 'yes' || lowerConfirm === 'correct' || lowerConfirm.includes('confirm') || lowerConfirm.includes('looks good') || lowerConfirm.includes("that's correct") || lowerConfirm.includes('that is correct');
    // Treat correction keywords or new address-like content as correction; confirmation takes precedence only for short confirm phrases
    var isCorrection = lowerConfirm.includes('wrong') || lowerConfirm.includes('incorrect') || lowerConfirm.includes('change') || lowerConfirm.includes('correct address') || lowerConfirm.includes('update');
    if (isConfirm && !isCorrection) {
      order.deliveryAddressConfirmed = true;
      var fullAddress = formatFullDeliveryAddress(order);
      var responseText = 'Delivery address confirmed: ' + fullAddress + '. You can now proceed to checkout.';
      var response = {
        systemPrompt: loadSystemPrompt(),
        text: responseText,
        action: 'delivery_confirmed',
        fullAddress: fullAddress,
        timestamp: new Date().toISOString()
      };
      history.push({ sender: 'customer', text: message, timestamp: new Date().toISOString() });
      history.push({ sender: 'bot', text: responseText, timestamp: new Date().toISOString(), action: 'delivery_confirmed' });
      res.json({ sessionId: sessionId, response: response, order: order, history: history });
      return;
    }
    if (!isConfirm) {
      var fullAddress = formatFullDeliveryAddress(order);
      var responseText = 'Please confirm your delivery address: ' + fullAddress + '. Reply "confirm" to confirm or provide the corrected address.';
      var response = {
        systemPrompt: loadSystemPrompt(),
        text: responseText,
        action: 'delivery_confirm',
        fullAddress: fullAddress,
        timestamp: new Date().toISOString()
      };
      history.push({ sender: 'customer', text: message, timestamp: new Date().toISOString() });
      history.push({ sender: 'bot', text: responseText, timestamp: new Date().toISOString(), action: 'delivery_confirm' });
      res.json({ sessionId: sessionId, response: response, order: order, history: history });
      return;
    }
  }

  if (pickupInfo.pickup || pickupInfo.name || pickupInfo.pickupTime) {
    order = initOrder(sessionId);
    if (pickupInfo.name) {
      order.customerDetails.name = pickupInfo.name;
    }
    if (pickupInfo.pickupTime) {
      order.customerDetails.pickupTime = pickupInfo.pickupTime;
    }
    if (pickupInfo.pickup && !order.orderType) {
      order.orderType = 'pickup';
    }
    calculateTotal(order);
    var missingPickup = hasMissingPickupInfo(order);
    var responseText = '';
    if (missingPickup.length > 0) {
      responseText = 'For pickup, I need a few more details. ';
      if (missingPickup.includes('name')) responseText += 'What is your name? ';
      if (missingPickup.includes('pickup time')) responseText += 'What time would you like to pick it up? ';
    } else if (order.items.length > 0) {
      responseText = 'Pickup details noted! Here is your order:';
    } else {
      responseText = 'Pickup order noted! Would you like to see the menu?';
    }
    var response = {
      systemPrompt: loadSystemPrompt(),
      text: responseText,
      action: 'pickup',
      timestamp: new Date().toISOString()
    };
    history.push({ sender: 'customer', text: message, timestamp: new Date().toISOString() });
    history.push({ sender: 'bot', text: responseText, timestamp: new Date().toISOString(), action: 'pickup' });
    res.json({ sessionId: sessionId, response: response, order: order, history: history });
    return;
  }

  // Auto-add valid menu item via chat (deterministic, validates against menu.json)
  if (typeof action === 'object' && action.item && action.item.available !== false) {
    var selected = action.detectedOption ? [action.detectedOption] : [];
    var missingForAdd = getMissingOptions(action.item, selected);
    if (missingForAdd.length === 0) {
      order = initOrder(sessionId);
      addToOrder(sessionId, action.item.id, 1, selected);
      order = getOrder(sessionId);
    }
  }

  var response = buildResponse(action, history, order);

  history.push({ sender: 'customer', text: message, timestamp: new Date().toISOString() });
  history.push({ sender: 'bot', text: response.text, timestamp: new Date().toISOString(), action: response.action });

  res.json({
    sessionId: sessionId,
    response: response,
    order: order,
    history: history
  });
});

app.get('/api/order/:sessionId', function (req, res) {
  var order = getOrder(req.params.sessionId);
  if (!order) {
    return res.status(404).json({ error: 'Session not found.' });
  }
  res.json({ order: order });
});

app.get('/api/order/:sessionId/summary', function (req, res) {
  var order = getOrder(req.params.sessionId);
  if (!order) {
    return res.status(404).json({ error: 'Session not found.' });
  }
  if (order.items.length === 0) {
    return res.status(400).json({ error: 'Cannot generate summary for empty order.' });
  }
  // Deterministic summary before checkout
  var summary = buildStructuredOrderSummary(order);
  var text = formatStructuredSummaryText(summary);
  res.json({ summary: summary, text: text });
});

app.get('/api/orders', function (req, res) {
  var ordersPath = path.join(__dirname, '..', 'data', 'orders.json');
  try {
    var raw = fs.readFileSync(ordersPath, 'utf-8');
    var orders = JSON.parse(raw);
    if (!Array.isArray(orders)) orders = [];
    res.json({ orders: orders });
  } catch (e) {
    res.json({ orders: [] });
  }
});

app.post('/api/orders/:orderId/status', function (req, res) {
  var orderId = req.params.orderId;
  var newStatus = req.body.status;
  var allowed = ['confirmed', 'preparing', 'ready', 'completed', 'cancelled'];
  if (!allowed.includes(newStatus)) {
    return res.status(400).json({ error: 'Invalid status. Allowed: ' + allowed.join(', ') });
  }
  var ordersPath = path.join(__dirname, '..', 'data', 'orders.json');
  try {
    var raw = fs.readFileSync(ordersPath, 'utf-8');
    var orders = JSON.parse(raw);
    if (!Array.isArray(orders)) orders = [];
    var idx = orders.findIndex(function (o) { return o.orderId === orderId; });
    if (idx === -1) return res.status(404).json({ error: 'Order not found.' });
    orders[idx].status = newStatus;
    // keep summary status in sync if present
    if (orders[idx].summary) orders[idx].summary.status = newStatus;
    fs.writeFileSync(ordersPath, JSON.stringify(orders, null, 2), 'utf-8');
    res.json({ order: orders[idx] });
  } catch (e) {
    return res.status(500).json({ error: 'Failed to update order.' });
  }
});

app.post('/api/order/:sessionId/add', function (req, res) {
  var sessionId = req.params.sessionId;
  var itemId = req.body.itemId;
  var quantity = req.body.quantity || 1;
  var options = req.body.options || [];

  var item = findMenuItem(itemId);
  if (!item) {
    return res.status(404).json({ error: 'Item not found in the menu.', itemId: itemId });
  }
  if (item.available === false) {
    return res.status(400).json({ error: item.name + ' is currently unavailable. Please choose an available item.' });
  }

  var missing = getMissingOptions(item, options);
  if (missing.length > 0) {
    return res.status(400).json({
      error: 'Missing required options for ' + item.name + '.',
      requiredOptions: missing,
      item: { id: item.id, name: item.name, sizes: item.sizes }
    });
  }

  var order = addToOrder(sessionId, itemId, quantity, options);
  if (!order) {
    return res.status(400).json({ error: 'Could not add item to order.' });
  }
  res.json({ order: order });
});

function updateOrderItem(sessionId, itemId, newQuantity, newOptions) {
  var order = getOrder(sessionId);
  if (!order) return { error: 'Session not found.' };

  var item = findMenuItem(itemId);
  if (!item) return { error: 'Item not found in the menu.' };

  var existing = order.items.find(function (i) { return i.id === itemId; });
  if (!existing) return { error: 'Item not in order.' };

  if (newOptions) {
    var missing = getMissingOptions(item, newOptions);
    if (missing.length > 0) {
      return { error: 'Missing required options for ' + item.name + '.', requiredOptions: missing };
    }
    existing.options = newOptions;
  }

  if (newQuantity !== undefined && newQuantity !== null) {
    if (typeof newQuantity !== 'number' || newQuantity < 1) {
      return { error: 'Quantity must be a number greater than 0.' };
    }
    existing.quantity = newQuantity;
  }

  order.total = calculateTotal(order);
  return { order: order };
}

app.post('/api/order/:sessionId/items/:itemId', function (req, res) {
  var sessionId = req.params.sessionId;
  var itemId = req.params.itemId;
  var newQuantity = req.body.quantity;
  var newOptions = req.body.options;

  var result = updateOrderItem(sessionId, itemId, newQuantity, newOptions);
  if (result.error) {
    var statusCode = result.error.includes('not found') ? 404 : 400;
    return res.status(statusCode).json({ error: result.error });
  }
  res.json({ order: result.order });
});

function reduceFromOrder(sessionId, itemId) {
  var order = getOrder(sessionId);
  if (!order) return { error: 'Session not found.' };

  var existing = order.items.find(function (i) { return i.id === itemId; });
  if (!existing) return { error: 'Item not in order.' };

  if (existing.quantity <= 1) {
    order.items = order.items.filter(function (i) { return i.id !== itemId; });
  } else {
    existing.quantity -= 1;
  }

  order.total = calculateTotal(order);
  return { order: order };
}

app.post('/api/order/:sessionId/items/:itemId/remove', function (req, res) {
  var sessionId = req.params.sessionId;
  var itemId = req.params.itemId;

  var result = reduceFromOrder(sessionId, itemId);
  if (result.error) {
    var statusCode = result.error.includes('not found') ? 404 : 400;
    return res.status(statusCode).json({ error: result.error });
  }
  res.json({ order: result.order });
});

app.post('/api/order/:sessionId/pickup', function (req, res) {
  var sessionId = req.params.sessionId;
  var name = req.body.name;
  var pickupTime = req.body.pickupTime;

  var order = initOrder(sessionId);
  if (!order.orderType || order.orderType !== 'pickup') {
    order.orderType = 'pickup';
  }
  var updated = updatePickupInfo(sessionId, name, pickupTime);

  var missing = hasMissingPickupInfo(updated);
  if (missing.length > 0) {
    res.json({ order: updated, missing: missing, message: 'Still need: ' + missing.join(', ') });
    return;
  }

  res.json({ order: updated, message: 'Pickup details complete!' });
});

app.post('/api/order/:sessionId/delivery', function (req, res) {
  var sessionId = req.params.sessionId;
  var name = req.body.name;
  var phone = req.body.phone;
  var address = req.body.address;
  var apartmentUnit = req.body.apartmentUnit;
  var instructions = req.body.instructions;

  var order = initOrder(sessionId);
  if (!order.orderType || order.orderType !== 'delivery') {
    order.orderType = 'delivery';
  }
  var updated = updateDeliveryInfo(sessionId, { name: name, phone: phone, address: address, apartmentUnit: apartmentUnit, instructions: instructions });

  var missing = hasMissingDeliveryInfo(updated);
  if (missing.length > 0) {
    res.json({ order: updated, missing: missing, message: 'Still need: ' + missing.join(', ') });
    return;
  }

  if (!updated.deliveryAddressConfirmed) {
    var fullAddress = formatFullDeliveryAddress(updated);
    res.json({ order: updated, fullAddress: fullAddress, message: 'Please confirm your delivery address: ' + fullAddress + '. Reply "confirm" to confirm or provide the corrected address.', needsConfirmation: true });
    return;
  }

  res.json({ order: updated, message: 'Delivery details complete!' });
});

app.post('/api/order/:sessionId/delivery/confirm', function (req, res) {
  var sessionId = req.params.sessionId;
  var result = confirmDeliveryAddress(sessionId);
  if (result.error) {
    return res.status(400).json({ error: result.error });
  }
  var fullAddress = formatFullDeliveryAddress(result.order);
  res.json({ order: result.order, fullAddress: fullAddress, message: 'Delivery address confirmed: ' + fullAddress });
});

app.post('/api/order/:sessionId/delivery/correct', function (req, res) {
  var sessionId = req.params.sessionId;
  var address = req.body.address;
  var apartmentUnit = req.body.apartmentUnit;
  var instructions = req.body.instructions;
  if (!address && !apartmentUnit && !instructions) {
    return res.status(400).json({ error: 'Provide corrected address, apartment/unit, or instructions.' });
  }
  var result = correctDeliveryAddress(sessionId, { address: address, apartmentUnit: apartmentUnit, instructions: instructions });
  if (result.error) {
    return res.status(400).json({ error: result.error });
  }
  res.json({ order: result.order, fullAddress: result.fullAddress, message: 'Address updated. Please confirm your delivery address: ' + result.fullAddress + '. Reply "confirm" to confirm.', needsConfirmation: true });
});

app.post('/api/order/:sessionId/promotion', function (req, res) {
  var sessionId = req.params.sessionId;
  var promotionId = req.body.promotionId;

  var result = applyPromotion(sessionId, promotionId);
  if (!result.success) {
    return res.status(400).json({ error: result.error || 'Promotion not valid or not active.' });
  }
  res.json({ order: getOrder(sessionId) });
});

app.post('/api/order/:sessionId/confirm', function (req, res) {
  var sessionId = req.params.sessionId;
  var order = initOrder(sessionId);

  if (order.items.length === 0) {
    return res.status(400).json({ error: 'Cannot confirm an empty order.' });
  }
  if (order.orderType === 'delivery') {
    var missing = hasMissingDeliveryInfo(order);
    if (missing.length > 0) {
      return res.status(400).json({ error: 'Missing delivery information: ' + missing.join(', ') });
    }
    if (!order.deliveryAddressConfirmed) {
      var fullAddress = formatFullDeliveryAddress(order);
      return res.status(400).json({ error: 'Delivery address not confirmed. Please confirm your delivery address: ' + fullAddress + '. Reply "confirm" to confirm or provide the corrected address.', fullAddress: fullAddress, needsConfirmation: true });
    }
  }
  if (order.orderType === 'pickup') {
    var missing = hasMissingPickupInfo(order);
    if (missing.length > 0) {
      return res.status(400).json({ error: 'Missing pickup information: ' + missing.join(', ') });
    }
  }
  // Deterministic structured summary before final checkout
  var summary = buildStructuredOrderSummary(order);
  var text = formatStructuredSummaryText(summary);
  var ok = confirmOrder(sessionId);
  if (!ok) {
    return res.status(400).json({ error: 'Cannot confirm order. Check order details.' });
  }
  var confirmedOrder = getOrder(sessionId);
  // refresh summary after confirmation (status updated)
  var finalSummary = buildStructuredOrderSummary(confirmedOrder);
  var finalText = formatStructuredSummaryText(finalSummary);
  // Persist only confirmed order - never draft
  var saved = saveConfirmedOrder(sessionId, finalSummary);
  res.json({ order: confirmedOrder, summary: finalSummary, text: finalText, preview: summary, savedOrder: saved });
});

app.listen(PORT, function () {
  console.log('CafeBot server running on port ' + PORT);
});
