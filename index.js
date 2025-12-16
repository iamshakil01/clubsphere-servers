const express = require('express');
const cors = require('cors');
const app = express();
require('dotenv').config();
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const stripe = require('stripe')(process.env.STRIPE_SECRET);

const port = process.env.PORT || 3000;
const crypto = require('crypto');

const admin = require("firebase-admin");

const decoded = Buffer.from(process.env.FB_SERVICE_KEY, 'base64').toString('utf8')
const serviceAccount = JSON.parse(decoded);

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});

function generateTrackingId() {
    const ts = Date.now().toString(36);
    const rand = crypto.randomBytes(8).toString('hex');
    return `${ts}-${rand}`;
}


                  // ----------------MiddleWare------------------
app.use(express.json());
app.use(cors());

const verifyFBToken = async (req, res, next) => {
    const token = req.headers.authorization;
    if (!token) {
        return res.status(401).send({ message: 'Unauthorized Access' });
    }
    try {
        const idToken = token.split(' ')[1];
        const decoded = await admin.auth().verifyIdToken(idToken);
        req.decoded_email = decoded.email;
        next();
    } catch (error) {
        return res.status(401).send({ message: 'Unauthorized Access' });
    }
};


const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASSWORD}@firstdb.2rqimp0.mongodb.net/?appName=FirstDB`;

const client = new MongoClient(uri, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    }
});

async function run() {
    try {
        await client.connect();
        const db = client.db('club-sphere-db');
        const userCollections = db.collection('users');
        const clubsCollections = db.collection('clubs');
        const membershipsCollections = db.collection('memberships');
        const eventsCollections = db.collection('events');
        const paymentCollections = db.collection('payments');
        const eventRegistrationsCollection = db.collection('eventRegistrations');


        // ---------------------Events APIs--------------------
        app.post("/events/:id/register", verifyFBToken, async (req, res) => {
            const eventId = req.params.id;
            const userEmail = req.decoded_email;

            const event = await eventsCollections.findOne({ _id: new ObjectId(eventId) });
            if (!event) return res.status(404).send({ message: "Event not found" });

            const exist = await eventRegistrationsCollection.findOne({
                eventId,
                userEmail,
                status: "registered"
            });

            if (exist) {
                return res.status(400).send({ message: "Already registered" });
            }

            const registration = {
                eventId,
                clubId: event.clubId,
                userEmail,
                status: "registered",
                paymentId: null,
                registeredAt: new Date()
            };

            const result = await eventRegistrationsCollection.insertOne(registration);
            res.send(result);
        });



        app.post('/events', async (req, res) => {
            const { clubId, title, description, date, location, price } = req.body;
            const event = {
                clubId,
                title,
                description,
                date: new Date(date),
                location,
                price: Number(price) || 0,
                createdAt: new Date()
            };
            try {
                const result = await eventsCollections.insertOne(event);
                res.status(201).send(result);
            } catch (err) {
                res.status(500).send({ message: 'Failed to create event' });
            }
        });


        app.get('/events', async (req, res) => {
            const { clubId } = req.query;
            const query = {};
            if (clubId) {
                query.clubId = new ObjectId(clubId);
            }
            try {
                const events = await eventsCollections.find(query).sort({ date: 1 }).toArray();
                res.send(events);
            } catch (err) {
                console.error('Failed to fetch events', err);
                res.status(500).send({ message: 'Failed to fetch events' });
            }
        });


        app.get('/admin', async (req, res) => {
            try {
                const totalUsers = await userCollections.countDocuments({});
                const totalClubs = await clubsCollections.countDocuments({});
                const pendingClubs = await clubsCollections.countDocuments({ status: "pending" });
                const approvedClubs = await clubsCollections.countDocuments({ status: "approved" });
                const totalMemberships = await membershipsCollections.countDocuments({});
                const totalEvents = await eventsCollections.countDocuments({});
                const paymentsAgg = await paymentCollections.aggregate([
                    { $group: { _id: null, total: { $sum: "$amount" } } }
                ]).toArray();
                const totalPayments = paymentsAgg[0]?.total || 0;

                res.send({
                    totalUsers,
                    totalClubs,
                    pendingClubs,
                    approvedClubs,
                    totalMemberships,
                    totalEvents,
                    totalPayments
                });
            } catch (error) {
                console.error('Error in /admin overview:', error);
                res.status(500).send({ message: 'Failed to fetch admin stats' });
            }
        });


         // ---------------------Dashboard APIs--------------------
        app.get('/dashboard/clubs-management', async (req, res) => {
            try {
                const result = await clubsCollections.find().sort({ createdAt: -1 }).toArray();
                res.send(result);
            } catch (error) {
                res.status(500).send({ message: "Failed to fetch clubs" });
            }
        });

        app.patch('/dashboard/clubs-management/:id/status', async (req, res) => {
            try {
                const { status } = req.body;
                const id = req.params.id;
                const result = await clubsCollections.updateOne(
                    { _id: new ObjectId(id) },
                    { $set: { status } }
                );
                res.send(result);
            } catch (error) {
                res.status(500).send({ message: "Failed to update status" });
            }
        });

          app.delete('/dashboard/clubs-management/:id', async (req, res) => {
            try {
                const id = req.params.id;
                const result = await clubsCollections.deleteOne({ _id: new ObjectId(id) });

                if (result.deletedCount === 0) {
                    return res.status(404).send({ message: "Club not found" });
                }

                await membershipsCollections.deleteMany({ clubId: id });
                await eventsCollections.deleteMany({ clubId: id });
                await paymentCollections.deleteMany({ clubId: id });

                res.send({ deletedCount: result.deletedCount });
            } catch (error) {
                console.error("Failed to delete club", error);
                res.status(500).send({ message: "Failed to delete club" });
            }
        });

        app.patch('/dashboard/clubs-management/:id', async (req, res) => {
            try {
                const clubId = req.params.id;

                const club = await clubsCollections.findOne({ _id: new ObjectId(clubId) });
                if (!club) return res.status(404).send({ message: "Club not found" });

                if (club.createdByEmail !== req.decoded_email) {
                    return res.status(403).send({ message: "Forbidden" });
                }

                const updateData = {
                    clubName: req.body.clubName || club.clubName,
                    description: req.body.description || club.description,
                    location: req.body.location || club.location,
                    membershipFee: req.body.membershipFee
                        ? Number(req.body.membershipFee)
                        : club.membershipFee,
                    category: req.body.category || club.category,
                    updatedAt: new Date()
                };

                if (req.body.bannerImage && req.body.bannerImage.trim() !== "") {
                    updateData.bannerImage = req.body.bannerImage;
                }

                const result = await clubsCollections.updateOne(
                    { _id: new ObjectId(clubId) },
                    { $set: updateData }
                );

                res.send(result);
            } catch (error) {
                console.error("Failed to update club:", error);
                res.status(500).send({ message: "Failed to update club" });
            }
        });


         // ---------------------Users APIs--------------------
        app.post('/users', async (req, res) => {
            const user = req.body;
            user.role = 'member';
            user.createdAt = new Date();
            const exist = await userCollections.findOne({ email: user.email });
            if (exist) return res.send({ message: "User already exists" });
            const result = await userCollections.insertOne(user);
            res.send(result);
        });

        app.get('/users', async (req, res) => {
            const result = await userCollections.find().toArray();
            res.send(result);
        });

        app.patch('/users/:id', async (req, res) => {
            const id = req.params.id;
            const roleInfo = req.body;
            const result = await userCollections.updateOne(
                { _id: new ObjectId(id) },
                { $set: { role: roleInfo.role } }
            );
            res.send(result);
        });

        app.get('/users/:email/role', verifyFBToken, async (req, res) => {
            const email = req.params.email;
            const user = await userCollections.findOne({ email });
            res.send({ role: user?.role || 'member' });
        });


         // ---------------------Clubs APIs--------------------
        app.post('/clubs', async (req, res) => {
            try {
                const club = req.body;
                const newClub = {
                    clubName: club.clubName,
                    description: club.description,
                    image: club.image,
                    category: club.category,
                    membershipFee: Number(club.membershipFee) || 0,
                    createdBy: club.createdBy,
                    status: "pending",
                    createdAt: new Date()
                };
                const result = await clubsCollections.insertOne(newClub);
                res.status(201).send(result);
            } catch (error) {
                res.status(500).send({ message: "Failed to create club" });
            }
        });

        app.get('/clubs', async (req, res) => {
            const result = await clubsCollections
                .find({ status: "approved" })
                .sort({ createdAt: -1 })
                .toArray();
            res.send(result);
        });

        app.get("/clubs/:id", async (req, res) => {
            const id = req.params.id;
            const result = await clubsCollections.findOne({ _id: new ObjectId(id) });
            res.send(result);
        });


        // ---------------Stripe Related APIs------------------
        app.post('/create-checkout-session', async (req, res) => {
            const paymentInfo = req.body;
            const existPayment = await paymentCollections.findOne({
                clubId: paymentInfo.clubId,
                customerEmail: paymentInfo.senderEmail,
                eventId: paymentInfo.eventId
            });

            if (existPayment) {
                return res.status(400).send({ message: "Already paid" });
            }
            const amount = parseInt(paymentInfo.cost) * 100;
            const session = await stripe.checkout.sessions.create({
                payment_method_types: ['card'],
                line_items: [
                    {
                        price_data: {
                            unit_amount: amount,
                            currency: 'USD',
                            product_data: { name: paymentInfo.clubName },
                        },
                        quantity: 1,
                    },
                ],
                mode: 'payment',
                customer_email: paymentInfo.senderEmail,
                metadata: {
                    eventId: paymentInfo.eventId,
                    clubId: paymentInfo.clubId
                },

                success_url: `${process.env.SITE_DOMAIN}/dashboard/payment-success?session_id={CHECKOUT_SESSION_ID}`,
                cancel_url: `${process.env.SITE_DOMAIN}/dashboard/payment-cancelled`,
            });

            res.send({ url: session.url });
        });


        // ---------------Payment Related APIs------------------
        app.patch('/payment-success', async (req, res) => {
            const sessionId = req.query.session_id;
            const session = await stripe.checkout.sessions.retrieve(sessionId);
            const transactionId = session.payment_intent;

            const paymentExist = await paymentCollections.findOne({ transactionId });
            if (paymentExist) {
                return res.send({
                    message: 'already exist',
                    transactionId,
                    trackingId: paymentExist.trackingId
                });
            }

            const trackingId = generateTrackingId();

            if (session.payment_status === 'paid') {

                const payment = {
                    amount: session.amount_total / 100,
                    currency: session.currency,
                    customerEmail: session.customer_email,
                    clubId: session.metadata.clubId,
                    clubName: session.metadata.clubName,
                    transactionId,
                    eventId: session.metadata.eventId,
                    paymentStatus: session.payment_status,
                    paidAt: new Date(),
                    trackingId
                };

                await paymentCollections.insertOne(payment);

                await eventRegistrationsCollection.insertOne({
                    eventId: session.metadata.eventId,
                    clubId: session.metadata.clubId,
                    userEmail: session.customer_email,
                    status: "registered",
                    paymentId: transactionId,
                    registeredAt: new Date()
                });

                return res.send({
                    success: true,
                    trackingId,
                    transactionId
                });
            }

            res.send({ success: false });
        });


        app.get('/payments', verifyFBToken, async (req, res) => {
            const email = req.query.email;
            const query = {};
            if (email) {
                if (email !== req.decoded_email) {
                    return res.status(403).send({ message: 'Forbidden Access' });
                }
                query.customerEmail = email;
            }

            const result = await paymentCollections.find(query).sort({ paidAt: -1 }).toArray();
            res.send(result);
        });


        // await client.db("admin").command({ ping: 1 });
        // console.log("Connected to MongoDB!");
    } finally {

    }
}

run().catch(console.dir);

app.get('/', (req, res) => {
    res.send('Club-Sphere is running!');
});

app.listen(port, () => {
    console.log(`Server listening on port ${port}`);
});
