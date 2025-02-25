// Continuing from the subscribe to membership tier route
app.post('/api/memberships/subscribe', authenticateUser, async (req, res) => {
  try {
    const { tier_id, payment_method_id } = req.body;
    
    // Get the tier details
    const tierResult = await pool.query(
      `SELECT t.*, u.stripe_account_id 
       FROM membership_tiers t
       JOIN users u ON t.creator_id = u.id
       WHERE t.id = $1`,
      [tier_id]
    );
    
    if (tierResult.rows.length === 0) {
      return res.status(404).json({ message: 'Membership tier not found' });
    }
    
    const tier = tierResult.rows[0];
    
    // Get subscriber details
    const userResult = await pool.query(
      'SELECT stripe_customer_id FROM users WHERE id = $1',
      [req.user.userId]
    );
    
    // Check if user is trying to subscribe to their own tier
    if (tier.creator_id === req.user.userId) {
      return res.status(400).json({ message: 'You cannot subscribe to your own membership tier' });
    }
    
    // Create subscription in Stripe
    const subscription = await stripe.subscriptions.create({
      customer: userResult.rows[0].stripe_customer_id,
      items: [{ price: tier.stripe_price_id }],
      default_payment_method: payment_method_id,
      application_fee_percent: 10, // Platform takes 10%
      transfer_data: {
        destination: tier.stripe_account_id
      }
    });
    
    // Record subscription in database
    const subscriptionResult = await pool.query(
      `INSERT INTO subscriptions (
        user_id, creator_id, tier_id, stripe_subscription_id, status
      ) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [
        req.user.userId,
        tier.creator_id,
        tier_id,
        subscription.id,
        subscription.status
      ]
    );
    
    res.status(201).json({
      message: 'Subscription created successfully',
      subscription: subscriptionResult.rows[0]
    });
    
  } catch (err) {
    console.error('Subscription error:', err);
    res.status(500).json({ message: 'Server error creating subscription' });
  }
});

// Cancel subscription route
app.post('/api/memberships/cancel', authenticateUser, async (req, res) => {
  try {
    const { subscription_id } = req.body;
    
    // Check if user owns the subscription
    const subscriptionCheck = await pool.query(
      'SELECT * FROM subscriptions WHERE id = $1 AND user_id = $2',
      [subscription_id, req.user.userId]
    );
    
    if (subscriptionCheck.rows.length === 0) {
      return res.status(403).json({ message: 'Subscription not found or not owned by you' });
    }
    
    // Cancel in Stripe
    await stripe.subscriptions.del(subscriptionCheck.rows[0].stripe_subscription_id);
    
    // Update in database
    await pool.query(
      `UPDATE subscriptions SET status = 'canceled', cancelled_at = NOW() WHERE id = $1`,
      [subscription_id]
    );
    
    res.status(200).json({ message: 'Subscription cancelled successfully' });
    
  } catch (err) {
    console.error('Subscription cancellation error:', err);
    res.status(500).json({ message: 'Server error cancelling subscription' });
  }
});

// Get user's purchased products
app.get('/api/shop/purchases', authenticateUser, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT p.*, o.purchased_at, ph.medium_url AS photo_url, u.username AS creator_username
       FROM orders o
       JOIN order_items oi ON o.id = oi.order_id
       JOIN products p ON oi.product_id = p.id
       JOIN photos ph ON p.photo_id = ph.id
       JOIN users u ON p.creator_id = u.id
       WHERE o.user_id = $1
       ORDER BY o.purchased_at DESC`,
      [req.user.userId]
    );
    
    res.status(200).json({
      purchases: result.rows
    });
    
  } catch (err) {
    console.error('Error fetching purchases:', err);
    res.status(500).json({ message: 'Server error fetching purchases' });
  }
});

// Get user's subscriptions
app.get('/api/memberships/subscriptions', authenticateUser, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT s.*, t.name AS tier_name, t.price, u.username AS creator_username,
        u.display_name AS creator_display_name, u.profile_image_url
       FROM subscriptions s
       JOIN membership_tiers t ON s.tier_id = t.id
       JOIN users u ON s.creator_id = u.id
       WHERE s.user_id = $1
       ORDER BY s.created_at DESC`,
      [req.user.userId]
    );
    
    res.status(200).json({
      subscriptions: result.rows
    });
    
  } catch (err) {
    console.error('Error fetching subscriptions:', err);
    res.status(500).json({ message: 'Server error fetching subscriptions' });
  }
});

// Get user profile
app.get('/api/users/:username', async (req, res) => {
  try {
    const { username } = req.params;
    
    // Get user details
    const userResult = await pool.query(
      `SELECT id, username, display_name, bio, profile_image_url, cover_image_url,
        is_creator, social_links, created_at,
        (SELECT COUNT(*) FROM subscriptions WHERE creator_id = users.id AND status = 'active') AS subscriber_count
       FROM users
       WHERE username = $1`,
      [username]
    );
    
    if (userResult.rows.length === 0) {
      return res.status(404).json({ message: 'User not found' });
    }
    
    const user = userResult.rows[0];
    
    // Get user's public photos
    const photosResult = await pool.query(
      `SELECT * FROM photos
       WHERE user_id = $1 AND is_public = true
       ORDER BY created_at DESC
       LIMIT 12`,
      [user.id]
    );
    
    // Get user's membership tiers if they are a creator
    const tiersResult = await pool.query(
      `SELECT * FROM membership_tiers
       WHERE creator_id = $1
       ORDER BY price ASC`,
      [user.id]
    );
    
    // Get user's products
    const productsResult = await pool.query(
      `SELECT p.*, ph.medium_url AS photo_url
       FROM products p
       JOIN photos ph ON p.photo_id = ph.id
       WHERE p.creator_id = $1
       ORDER BY p.created_at DESC
       LIMIT 8`,
      [user.id]
    );
    
    res.status(200).json({
      user,
      photos: photosResult.rows,
      tiers: user.is_creator ? tiersResult.rows : [],
      products: productsResult.rows
    });
    
  } catch (err) {
    console.error('Error fetching user profile:', err);
    res.status(500).json({ message: 'Server error fetching user profile' });
  }
});

// Update user profile
app.patch('/api/users/profile', authenticateUser, async (req, res) => {
  try {
    const { display_name, bio, social_links } = req.body;
    
    const result = await pool.query(
      `UPDATE users
       SET display_name = COALESCE($1, display_name),
           bio = COALESCE($2, bio),
           social_links = COALESCE($3, social_links),
           updated_at = NOW()
       WHERE id = $4
       RETURNING id, username, display_name, bio, profile_image_url, social_links`,
      [display_name, bio, social_links, req.user.userId]
    );
    
    res.status(200).json({
      message: 'Profile updated successfully',
      user: result.rows[0]
    });
    
  } catch (err) {
    console.error('Error updating profile:', err);
    res.status(500).json({ message: 'Server error updating profile' });
  }
});

// Upload profile or cover image
app.post('/api/users/upload-image', authenticateUser, upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: 'No image uploaded' });
    }
    
    const { type } = req.body; // 'profile' or 'cover'
    
    if (type !== 'profile' && type !== 'cover') {
      return res.status(400).json({ message: 'Invalid image type' });
    }
    
    const fileKey = `users/${req.user.userId}/${type}-${Date.now()}.jpg`;
    
    // Upload to S3
    const uploadParams = {
      Bucket: process.env.S3_BUCKET_NAME,
      Key: fileKey,
      Body: req.file.buffer,
      ContentType: req.file.mimetype
    };
    
    const uploadResult = await s3.upload(uploadParams).promise();
    
    // Update user record
    const updateField = type === 'profile' ? 'profile_image_url' : 'cover_image_url';
    
    await pool.query(
      `UPDATE users SET ${updateField} = $1 WHERE id = $2`,
      [uploadResult.Location, req.user.userId]
    );
    
    res.status(200).json({
      message: `${type} image updated successfully`,
      url: uploadResult.Location
    });
    
  } catch (err) {
    console.error('Image upload error:', err);
    res.status(500).json({ message: 'Server error uploading image' });
  }
});

// Create checkout session for products
app.post('/api/shop/checkout', authenticateUser, async (req, res) => {
  try {
    const { items, shipping_address } = req.body;
    
    if (!items || items.length === 0) {
      return res.status(400).json({ message: 'No items in cart' });
    }
    
    // Get user info
    const userResult = await pool.query(
      'SELECT stripe_customer_id FROM users WHERE id = $1',
      [req.user.userId]
    );
    
    // Get product details
    const productIds = items.map(item => item.product_id);
    const productsResult = await pool.query(
      `SELECT p.*, u.stripe_account_id, u.username AS creator_username
       FROM products p
       JOIN users u ON p.creator_id = u.id
       WHERE p.id = ANY($1)`,
      [productIds]
    );
    
    if (productsResult.rows.length !== items.length) {
      return res.status(400).json({ message: 'One or more products not found' });
    }
    
    // Check inventory for physical products
    for (const item of items) {
      const product = productsResult.rows.find(p => p.id === item.product_id);
      
      if (product.product_type === 'physical' && (product.inventory_count < item.quantity)) {
        return res.status(400).json({ 
          message: `Not enough inventory for ${product.name}`,
          available: product.inventory_count
        });
      }
    }
    
    // Create an order in the database
    const orderResult = await pool.query(
      `INSERT INTO orders (
        user_id, status, shipping_address
      ) VALUES ($1, $2, $3) RETURNING *`,
      [req.user.userId, 'pending', shipping_address]
    );
    
    const order = orderResult.rows[0];
    
    // Insert order items
    for (const item of items) {
      const product = productsResult.rows.find(p => p.id === item.product_id);
      
      await pool.query(
        `INSERT INTO order_items (
          order_id, product_id, quantity, price_per_unit
        ) VALUES ($1, $2, $3, $4)`,
        [order.id, item.product_id, item.quantity, product.price]
      );
    }
    
    // Create line items for Stripe
    const lineItems = items.map(item => {
      const product = productsResult.rows.find(p => p.id === item.product_id);
      return {
        price: product.stripe_price_id,
        quantity: item.quantity
      };
    });
    
    // Create Stripe checkout session
    const session = await stripe.checkout.sessions.create({
      customer: userResult.rows[0].stripe_customer_id,
      payment_method_types: ['card'],
      line_items: lineItems,
      mode: 'payment',
      success_url: `${process.env.FRONTEND_URL}/shop/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.FRONTEND_URL}/shop/cart`,
      metadata: {
        order_id: order.id
      },
      shipping_address_collection: {
        allowed_countries: ['US', 'CA', 'GB', 'AU']
      }
    });
    
    // Update order with session ID
    await pool.query(
      `UPDATE orders SET stripe_session_id = $1 WHERE id = $2`,
      [session.id, order.id]
    );
    
    res.status(200).json({
      session_id: session.id,
      order_id: order.id
    });
    
  } catch (err) {
    console.error('Checkout error:', err);
    res.status(500).json({ message: 'Server error creating checkout session' });
  }
});

// Webhook handler for Stripe events
app.post('/api/webhooks/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature verification failed:', err);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
  
  // Handle the event
  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object;
      
      // Update order status
      await pool.query(
        `UPDATE orders SET status = 'paid', paid_at = NOW() WHERE stripe_session_id = $1`,
        [session.id]
      );
      
      // Get order details
      const orderResult = await pool.query(
        `SELECT * FROM orders WHERE stripe_session_id = $1`,
        [session.id]
      );
      
      if (orderResult.rows.length > 0) {
        const order = orderResult.rows[0];
        
        // Get order items
        const itemsResult = await pool.query(
          `SELECT oi.*, p.product_type, p.creator_id 
           FROM order_items oi
           JOIN products p ON oi.product_id = p.id
           WHERE oi.order_id = $1`,
          [order.id]
        );
        
        // Update inventory for physical products
        for (const item of itemsResult.rows) {
          if (item.product_type === 'physical') {
            await pool.query(
              `UPDATE products 
               SET inventory_count = inventory_count - $1 
               WHERE id = $2`,
              [item.quantity, item.product_id]
            );
          }
        }
      }
      break;
    }
    
    case 'subscription_schedule.created': {
      // Handle new subscription
      const subscription = event.data.object;
      
      // Update subscription status
      await pool.query(
        `UPDATE subscriptions SET status = $1 WHERE stripe_subscription_id = $2`,
        [subscription.status, subscription.id]
      );
      break;
    }
    
    case 'subscription_schedule.canceled': {
      // Handle subscription cancellation
      const subscription = event.data.object;
      
      // Update subscription status
      await pool.query(
        `UPDATE subscriptions 
         SET status = 'canceled', cancelled_at = NOW() 
         WHERE stripe_subscription_id = $1`,
        [subscription.id]
      );
      break;
    }
  }
  
  res.json({ received: true });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({
    message: 'An unexpected error occurred',
    error: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

// Start the server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

module.exports = app;
